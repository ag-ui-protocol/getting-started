use crate::JsonValue;
use crate::types::context::Context;
use crate::types::ids::{RunId, ThreadId};
use crate::types::message::Message;
use crate::types::tool::Tool;
use serde::{Deserialize, Serialize};

/// An interrupt raised during an agent run for human-in-the-loop workflows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Interrupt {
    pub id: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(rename = "responseSchema", skip_serializing_if = "Option::is_none")]
    pub response_schema: Option<JsonValue>,
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonValue>,
}

impl Interrupt {
    pub fn new(id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            reason: reason.into(),
            message: None,
            tool_call_id: None,
            response_schema: None,
            expires_at: None,
            metadata: None,
        }
    }
}

/// A resume response for a previously emitted interrupt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResumeEntry {
    #[serde(rename = "interruptId")]
    pub interrupt_id: String,
    pub status: ResumeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<JsonValue>,
}

impl ResumeEntry {
    pub fn new(interrupt_id: impl Into<String>, status: ResumeStatus) -> Self {
        Self {
            interrupt_id: interrupt_id.into(),
            status,
            payload: None,
        }
    }
}

/// Status for a resume entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumeStatus {
    Resolved,
    Cancelled,
}

/// Input for running an agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunAgentInput<StateT = JsonValue, FwdPropsT = JsonValue> {
    #[serde(rename = "threadId")]
    pub thread_id: ThreadId,
    #[serde(rename = "runId")]
    pub run_id: RunId,
    #[serde(rename = "parentRunId", skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<RunId>,
    pub state: StateT,
    pub messages: Vec<Message>,
    pub tools: Vec<Tool>,
    pub context: Vec<Context>,
    #[serde(rename = "forwardedProps")]
    pub forwarded_props: FwdPropsT,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume: Option<Vec<ResumeEntry>>,
}

impl<StateT, FwdPropsT> RunAgentInput<StateT, FwdPropsT> {
    pub fn new(
        thread_id: impl Into<ThreadId>,
        run_id: impl Into<RunId>,
        state: StateT,
        messages: Vec<Message>,
        tools: Vec<Tool>,
        context: Vec<Context>,
        forwarded_props: FwdPropsT,
    ) -> Self {
        Self {
            thread_id: thread_id.into(),
            run_id: run_id.into(),
            parent_run_id: None,
            state,
            messages,
            tools,
            context,
            forwarded_props,
            resume: None,
        }
    }

    pub fn with_parent_run_id(mut self, parent_run_id: impl Into<RunId>) -> Self {
        self.parent_run_id = Some(parent_run_id.into());
        self
    }

    pub fn with_resume(mut self, resume: Vec<ResumeEntry>) -> Self {
        self.resume = Some(resume);
        self
    }
}
