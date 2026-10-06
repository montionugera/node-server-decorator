#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceContext {
    pub version: String,
    pub trace_id: String,
    pub parent_id: String,
    pub trace_flags: String,
}

impl TraceContext {
    pub fn parse(header: &str) -> Option<Self> {
        let parts: Vec<&str> = header.split('-').collect();
        if parts.len() != 4 {
            return None;
        }
        let (ver, trace_id, parent_id, flags) = (parts[0], parts[1], parts[2], parts[3]);
        if ver != "00" {
            return None;
        }
        if trace_id.len() != 32
            || trace_id == "00000000000000000000000000000000"
            || !trace_id.chars().all(|c| c.is_ascii_hexdigit())
        {
            return None;
        }
        if parent_id.len() != 16
            || parent_id == "0000000000000000"
            || !parent_id.chars().all(|c| c.is_ascii_hexdigit())
        {
            return None;
        }
        if flags.len() != 2 || !flags.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        Some(Self {
            version: ver.to_string(),
            trace_id: trace_id.to_string(),
            parent_id: parent_id.to_string(),
            trace_flags: flags.to_string(),
        })
    }

    pub fn to_header(&self) -> String {
        format!(
            "{}-{}-{}-{}",
            self.version, self.trace_id, self.parent_id, self.trace_flags
        )
    }
}
