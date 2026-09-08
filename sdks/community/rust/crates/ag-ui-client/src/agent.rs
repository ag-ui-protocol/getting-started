use futures::stream::StreamExt;
use std::collections::HashSet;

use crate::core::JsonValue;
use crate::core::types::{
    AgentId, Context, Message, MessageId, ResumeEntry, RunAgentInput, RunId, ThreadId, Tool,
};
use crate::core::{AgentState, FwdProps};
use crate::event_handler::EventHandler;
use crate::stream::EventStream;
use crate::subscriber::IntoSubscribers;

/// Configuration for an Agent.
#[derive(Debug, Clone)]
pub struct AgentConfig<StateT = JsonValue> {
    pub agent_id: Option<AgentId>,
    pub description: Option<String>,
    pub thread_id: Option<ThreadId>,
    pub initial_messages: Option<Vec<Message>>,
    pub initial_state: Option<StateT>,
    pub debug: Option<bool>,
}

impl<S> Default for AgentConfig<S>
where
    S: Default,
{
    fn default() -> Self {
        Self {
            agent_id: None,
            description: None,
            thread_id: None,
            initial_messages: None,
            initial_state: None,
            debug: None,
        }
    }
}

/// Parameters for running an agent.
#[derive(Debug, Clone, Default)]
pub struct RunAgentParams<StateT: AgentState = JsonValue, FwdPropsT: FwdProps = JsonValue> {
    pub run_id: Option<RunId>,
    pub parent_run_id: Option<RunId>,
    pub tools: Vec<Tool>,
    pub context: Vec<Context>,
    pub forwarded_props: FwdPropsT,
    pub messages: Vec<Message>,
    pub state: StateT,
    pub resume: Option<Vec<ResumeEntry>>,
}

impl<StateT, FwdPropsT> RunAgentParams<StateT, FwdPropsT>
where
    StateT: AgentState + Default,
    FwdPropsT: FwdProps + Default,
{
    /// Construct a new instance of [RunAgentParams] where the state and forwarded_props are
    /// manually typed.
    ///
    /// If you do not need this level of customization, use [RunAgentParams::new].
    pub fn new_typed() -> Self {
        Self {
            run_id: None,
            parent_run_id: None,
            tools: Vec::new(),
            context: Vec::new(),
            forwarded_props: FwdPropsT::default(),
            messages: Vec::new(),
            state: StateT::default(),
            resume: None,
        }
    }

    pub fn with_run_id(mut self, run_id: RunId) -> Self {
        self.run_id = Some(run_id);
        self
    }
    pub fn with_parent_run_id(mut self, parent_run_id: RunId) -> Self {
        self.parent_run_id = Some(parent_run_id);
        self
    }
    pub fn with_resume(mut self, resume: Vec<ResumeEntry>) -> Self {
        self.resume = Some(resume);
        self
    }
    pub fn add_tool(mut self, tool: Tool) -> Self {
        self.tools.push(tool);
        self
    }
    pub fn add_context(mut self, ctx: Context) -> Self {
        self.context.push(ctx);
        self
    }
    pub fn with_forwarded_props(mut self, props: FwdPropsT) -> Self {
        self.forwarded_props = props;
        self
    }
    pub fn with_state(mut self, state: StateT) -> Self {
        self.state = state;
        self
    }
    pub fn add_message(mut self, msg: Message) -> Self {
        self.messages.push(msg);
        self
    }
    pub fn user(mut self, content: impl Into<String>) -> Self {
        self.messages.push(Message::User {
            id: MessageId::random(),
            content: content.into(),
            name: None,
            encrypted_value: None,
        });
        self
    }
}

impl RunAgentParams<JsonValue, JsonValue> {
    /// Construct an empty parameter object with JSON Values for state and forwarded props.
    ///
    /// If you want typed state and/or forwarded_props, use [RunAgentParams::new_typed].
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone)]
pub struct RunAgentResult<StateT: AgentState> {
    pub result: JsonValue,
    pub new_messages: Vec<Message>,
    pub new_state: StateT,
}

pub type AgentRunState<StateT, FwdPropsT> = RunAgentInput<StateT, FwdPropsT>;

#[derive(Debug, Clone)]
pub struct AgentStateMutation<StateT = JsonValue> {
    pub messages: Option<Vec<Message>>,
    pub state: Option<StateT>,
    pub stop_propagation: bool,
}

impl<StateT> Default for AgentStateMutation<StateT> {
    fn default() -> Self {
        Self {
            messages: None,
            state: None,
            stop_propagation: false,
        }
    }
}

// Error types
pub use crate::error::AgUiClientError as AgentError;

// TODO: Expand documentation
/// Agent trait
#[async_trait::async_trait]
pub trait Agent<StateT = JsonValue, FwdPropsT = JsonValue>: Send + Sync
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
    async fn run(
        &self,
        input: &RunAgentInput<StateT, FwdPropsT>,
    ) -> Result<EventStream<'async_trait, StateT>, AgentError>;

    /// Triggers an Agent run.
    ///
    /// # Parameters
    /// * `params`: The run parameters as given in [RunAgentParams]
    /// * `subscribers`: A (sequence of) type(s) that implement [crate::subscriber::AgentSubscriber];
    /// can also be a unit type `()` or `None` if none are needed. Valid types are `T`, `(T,)`,
    /// `Vec<T>`, `&[T]`, `()`, `Option<()>` where `T: AgentSubscriber`.
    ///
    /// # Examples
    /// ```no_run
    /// # use ag_ui_client::{Agent, HttpAgent, RunAgentParams, core::types::Message};
    /// # use std::error::Error;
    ///
    /// # #[tokio::main]
    /// # async fn main() -> Result<(), Box<dyn Error>> {
    ///  let agent = HttpAgent::builder()
    ///     .with_url_str("http://127.0.0.1:3000/")?
    ///     .build()?;
    ///
    ///  let message = Message::new_user("Can you give me the current temperature in New York?");
    ///  // Create run parameters
    ///  let params = RunAgentParams::new().add_message(message);
    ///
    ///  // Run the agent without subscriber
    ///  let result = agent.run_agent(&params, ()).await?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Notes
    /// Currently the subscriber pattern is the only way to subscriber to an Agent run's lifecycle.
    async fn run_agent(
        &self,
        params: &RunAgentParams<StateT, FwdPropsT>,
        subscribers: impl IntoSubscribers<StateT, FwdPropsT>,
    ) -> Result<RunAgentResult<StateT>, AgentError> {
        let input = RunAgentInput {
            thread_id: ThreadId::random(),
            run_id: params.run_id.clone().unwrap_or_else(RunId::random),
            parent_run_id: params.parent_run_id.clone(),
            state: params.state.clone(),
            messages: params.messages.clone(),
            tools: params.tools.clone(),
            context: params.context.clone(),
            forwarded_props: params.forwarded_props.clone(),
            resume: params.resume.clone(),
        };
        let current_message_ids: HashSet<&MessageId> =
            params.messages.iter().map(|m| m.id()).collect();

        // Initialize event handler with the current state
        let subscribers = subscribers.into_subscribers();
        let mut event_handler = EventHandler::new(
            params.messages.clone(),
            params.state.clone(),
            &input,
            subscribers,
        );

        let mut stream = self.run(&input).await?.fuse();

        while let Some(event_result) = stream.next().await {
            match event_result {
                Ok(event) => {
                    let mutation = event_handler.handle_event(&event).await?;
                    event_handler.apply_mutation(mutation).await?;
                }
                Err(e) => {
                    event_handler.on_error(&e).await?;
                    return Err(e);
                }
            }
        }

        // Finalize the run
        event_handler.on_finalize().await?;

        // Collect new messages
        let new_messages = event_handler
            .messages
            .iter()
            .filter(|m| !current_message_ids.contains(&m.id()))
            .cloned()
            .collect();

        Ok(RunAgentResult {
            result: event_handler.result,
            new_messages,
            new_state: event_handler.state,
        })
    }

    fn agent_id(&self) -> Option<&AgentId> {
        None
    }
}
