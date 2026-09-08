use ag_ui_client::sse::SseResponseExt;
use futures::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

#[tokio::test]
#[ignore = "requires a live external SSE service (httpbun.org); not provided in CI"]
async fn test_sse_with_httpbun() {
    // Create a reqwest client
    let client = Client::new();

    // Make a request to httpbun.org/sse
    let response = client
        .get("https://httpbun.org/sse")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .expect("Failed to send request to httpbun.org/sse");

    // Get the events stream
    let mut stream = response.event_source().await;

    // Collect a few events
    let mut events: Vec<_> = Vec::new();
    let mut count = 0;

    // Collect up to 5 events
    while let Some(result) = stream.next().await {
        match result {
            Ok(event) => {
                println!("Received event: {:?}", event);
                events.push(event);
                count += 1;
                if count >= 5 {
                    break;
                }
            }
            Err(err) => {
                panic!("Error receiving SSE event: {}", err);
            }
        }
    }

    // Verify that we received events
    assert!(
        !events.is_empty(),
        "No events received from httpbun.org/sse"
    );

    // Verify the event format
    for event in &events {
        // Check that the event has the expected format
        assert!(event.id.is_some(), "Event should have an ID");
        assert_eq!(
            event.data, "a ping event",
            "Event data should be 'a ping event'"
        );
    }

    // Verify that the IDs are sequential
    for i in 1..events.len() {
        let prev_id = events[i - 1].id.as_ref().unwrap().parse::<i32>().unwrap();
        let curr_id = events[i].id.as_ref().unwrap().parse::<i32>().unwrap();
        assert_eq!(curr_id, prev_id + 1, "Event IDs should be sequential");
    }
}

#[tokio::test]
#[ignore = "requires a live external SSE service (sse.dev); not provided in CI"]
async fn test_sse_with_json_data() {
    // Create a reqwest client
    let client = Client::new();

    #[derive(Debug, Deserialize)]
    #[allow(unused)]
    struct UserData {
        name: String,
        age: u16,
    }

    // Make a request to httpbun.org/sse
    let response = client
        .get(r#"https://sse.dev/test?jsonobj={"name":"werner","age":38}"#)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .expect("Failed to send request to sse.dev");

    // Get the events stream
    let mut stream = response.event_source().await;

    // Collect a few events
    let mut events: Vec<_> = Vec::new();
    let mut count = 0;

    // Collect up to 5 events
    while let Some(result) = stream.next().await {
        match result {
            Ok(event) => {
                println!("Received event: {:?}", event);
                let user_data: UserData = serde_json::from_str(&event.data).unwrap();
                println!("{user_data:?}");
                events.push(event);
                count += 1;
                if count >= 2 {
                    break;
                }
            }
            Err(err) => {
                panic!("Error receiving SSE event: {}", err);
            }
        }
    }
}
