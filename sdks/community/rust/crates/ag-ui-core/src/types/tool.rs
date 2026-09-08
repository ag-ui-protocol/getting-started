use crate::types::ids::ToolCallId;
use crate::types::message::FunctionCall;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: ToolCallId,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: FunctionCall,
    #[serde(rename = "encryptedValue", skip_serializing_if = "Option::is_none")]
    pub encrypted_value: Option<String>,
}

impl ToolCall {
    pub fn new(id: impl Into<ToolCallId>, function: FunctionCall) -> Self {
        Self {
            id: id.into(),
            call_type: "function".to_string(),
            function,
            encrypted_value: None,
        }
    }

    pub fn with_encrypted_value(mut self, encrypted_value: impl Into<String>) -> Self {
        self.encrypted_value = Some(encrypted_value.into());
        self
    }
}

/// A tool definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tool {
    /// The tool name
    pub name: String,
    /// The tool description
    pub description: String,
    /// The tool parameters
    pub parameters: serde_json::Value,
    /// Arbitrary tool metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

impl Tool {
    pub fn new(name: String, description: String, parameters: JsonValue) -> Self {
        Self {
            name,
            description,
            parameters,
            metadata: None,
        }
    }

    pub fn with_metadata(mut self, metadata: JsonValue) -> Self {
        self.metadata = Some(metadata);
        self
    }
}
