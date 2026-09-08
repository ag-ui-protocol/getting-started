use ag_ui_client::HttpAgent;
use ag_ui_client::agent::{Agent, RunAgentParams};
use ag_ui_client::core::types::{Message, Role};

#[tokio::test]
#[ignore = "requires a live AG-UI backend (localhost:3001); not provided in CI"]
async fn test_http_agent_basic_functionality() {
    env_logger::init();

    // Create an HttpAgent
    let agent = HttpAgent::builder()
        .with_url_str("http://localhost:3001/")
        .unwrap()
        .build()
        .unwrap();

    // Create a message asking about temperature
    let message = Message::new_user("What's the temperature in Amsterdam?");

    // Set up the run parameters
    let params = RunAgentParams::new().add_message(message);

    // Run the agent
    let result = agent.run_agent(&params, ()).await;

    // Check that the run was successful
    assert!(result.is_ok(), "Agent run failed: {:?}", result.err());

    // Check that we got some messages back
    let result = result.unwrap();
    assert!(!result.new_messages.is_empty(), "No messages returned");

    // Print the messages for debugging
    for msg in &result.new_messages {
        println!("Message role: {:?}", msg.role());
        println!("Message content: {:?}", msg.content().unwrap());
        if let Some(tool_calls) = msg.tool_calls() {
            for tool_call in tool_calls {
                println!(
                    "Tool call: {} with args {}",
                    tool_call.function.name, tool_call.function.arguments
                );
            }
        }
    }

    // Check that we got a response from the assistant
    assert!(
        result
            .new_messages
            .iter()
            .any(|m| m.role() == Role::Assistant),
        "No assistant messages returned"
    );
}

#[tokio::test]
#[ignore = "requires a live AG-UI backend (localhost:3001); not provided in CI"]
async fn test_http_agent_tool_calls() {
    // Create an HttpAgent
    let agent = HttpAgent::builder()
        .with_url_str("http://localhost:3001/")
        .unwrap()
        .build()
        .unwrap();

    // Create a message that should trigger a tool call
    let message = Message::new_user("What's the temperature in Amsterdam in Celsius?");

    // Set up the run parameters
    let params = RunAgentParams::new().add_message(message);

    // Run the agent
    let result = agent.run_agent(&params, ()).await;

    // Check that the run was successful
    assert!(result.is_ok(), "Agent run failed: {:?}", result.err());

    // Check that we got some messages back
    let result = result.unwrap();
    assert!(!result.new_messages.is_empty(), "No messages returned");

    // Check that at least one message has tool calls
    let has_tool_calls = result.new_messages.iter().any(|m| {
        if let Some(tool_calls) = m.tool_calls() {
            !tool_calls.is_empty()
        } else {
            false
        }
    });

    assert!(has_tool_calls, "No tool calls were made");
}

#[tokio::test]
async fn test_http_agent_error_handling() {
    // Create an HttpAgent with an invalid URL
    let agent = HttpAgent::builder()
        .with_url_str("http://localhost:9999/invalid")
        .unwrap()
        .build()
        .unwrap();

    // Create a simple message
    let message = Message::new_user("Hello.");

    // Set up the run parameters
    let params = RunAgentParams::new().add_message(message);

    // Run the agent
    let result = agent.run_agent(&params, ()).await;

    // Check that the run failed as expected
    assert!(
        result.is_err(),
        "Agent run should have failed but succeeded"
    );
}
