use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMessage {
    pub event_name: String,
    pub payload: Value,
    pub timestamp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, Value>>,
}

impl QueueMessage {
    pub fn new(event_name: impl Into<String>, payload: Value) -> Self {
        let now_ms = chrono::Utc::now().timestamp_millis();
        Self {
            event_name: event_name.into(),
            payload,
            timestamp: now_ms,
            metadata: None,
        }
    }

    pub fn with_metadata(mut self, metadata: HashMap<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }
}
