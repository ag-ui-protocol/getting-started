#include "sse_parser.h"
#include "core/error.h"

namespace agui {

void SseParser::feed(const std::string& chunk) {
    // Check buffer size limit to prevent memory exhaustion.
    // m_currentData is included because processBuffer() erases consumed bytes
    // from m_buffer, so a single unterminated event delivered as many small
    // chunks would otherwise keep m_buffer small while the per-event
    // accumulator grew without bound.
    if (m_buffer.size() + m_currentData.size() + chunk.size() > kMaxBufferSize) {
        throw SseBufferExceededError(
            "SSE buffer size exceeded maximum limit of " + 
            std::to_string(kMaxBufferSize / (1024 * 1024)) + " MB");
    }
    m_buffer += chunk;
    processBuffer();
}

bool SseParser::hasEvent() const {
    return !m_eventStrings.empty();
}

std::string SseParser::nextEvent() {
    if (m_eventStrings.empty()) {
        return "";
    }
    
    std::string jsonStr = m_eventStrings.front();
    m_eventStrings.pop();
    return jsonStr;
}

void SseParser::clear() {
    m_buffer.clear();
    m_processed_pos = 0;
    while (!m_eventStrings.empty()) {
        m_eventStrings.pop();
    }
    m_currentData.clear();
}

void SseParser::flush() {
    processBuffer();

    // Process any remaining partial line that has no trailing newline
    if (!m_buffer.empty()) {
        std::string line = std::move(m_buffer);
        m_buffer.clear();
        m_processed_pos = 0;

        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }
        if (!line.empty()) {
            parseLine(line);
        }
    }

    // Force completion of any accumulated event data
    if (!m_currentData.empty()) {
        finishEvent();
    }
}

void SseParser::processBuffer() {
    size_t start = m_processed_pos;
    size_t pos;

    while ((pos = m_buffer.find('\n', start)) != std::string::npos) {
        std::string line = m_buffer.substr(start, pos - start);
        start = pos + 1;

        // Remove trailing \r
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }

        // Empty line indicates end of event
        if (line.empty()) {
            finishEvent();
        } else {
            parseLine(line);
        }
    }

    m_processed_pos = start;

    // Truncate already-processed data from the front of the buffer.
    // This keeps m_buffer bounded to at most one incomplete SSE event,
    // preventing the overflow check in feed() from falsely triggering
    // on long-lived connections.
    if (m_processed_pos > 0) {
        m_buffer.erase(0, m_processed_pos);
        m_processed_pos = 0;
    }
}

void SseParser::parseLine(const std::string& line) {
    if (!line.empty() && line[0] == ':') {  // SSE comment line
        return;
    }

    size_t colonPos = line.find(':');
    if (colonPos == std::string::npos) {
        // SSE spec: bare field name with no colon → field name with empty value.
        // Per the spec, only the "data" field accumulates event payload.
        if (line == "data") {
            if (!m_currentData.empty()) {
                m_currentData += "\n";
            }
            // value is empty string — nothing more to append
        }
        return;
    }

    std::string field = line.substr(0, colonPos);
    std::string value = line.substr(colonPos + 1);

    if (!value.empty() && value[0] == ' ') {  // SSE spec: strip single leading space
        value = value.substr(1);
    }

    if (field == "data") {
        if (!m_currentData.empty()) {
            m_currentData += "\n";
        }
        m_currentData += value;
    }
}

void SseParser::finishEvent() {
    if (!m_currentData.empty()) {
        m_eventStrings.push(m_currentData);
        m_currentData.clear();
    }
}

}  // namespace agui
