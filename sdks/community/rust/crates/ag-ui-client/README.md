# AG-UI Rust Client

Rust client for working with the AG-UI protocol. The client API has been designed to mimic the Typescript client as 
close as possible. However, a key difference is that state & messages are not yet an attribute of an implementation of 
[`Agent`](src/agent.rs) because it would require `&mut self` for straightforward implementations. This is a work in 
progress.

## Example

For each example make sure to read the instructions on starting the associated AG-UI server.

### Basic 

```rust,no_run
// no_run: this example connects to a live AG-UI backend (127.0.0.1:3001),
// which is not available during `cargo test`. It is still compiled/type-checked.
use std::error::Error;
use ag_ui_client::{core::types::Message, Agent, HttpAgent, RunAgentParams};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>>{
	let agent = HttpAgent::builder()
		.with_url_str("http://127.0.0.1:3001/")?
		.build()?;

	let message = Message::new_user("Can you give me the current temperature in New York?");
	// Create run parameters
	let params = RunAgentParams::new().add_message(message);

	// Run the agent with the subscriber
	let result = agent.run_agent(&params, ()).await?;

    println!("{:#?}", result);
    Ok(())
}
```

For more examples check the [examples folder](examples). 