using System;

namespace AGUIDotnet.Events;

public static class EventTypes
{
    public const string TEXT_MESSAGE_START = "TEXT_MESSAGE_START";
    public const string TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT";
    public const string TEXT_MESSAGE_END = "TEXT_MESSAGE_END";
    public const string TOOL_CALL_START = "TOOL_CALL_START";
    public const string TOOL_CALL_ARGS = "TOOL_CALL_ARGS";
    public const string TOOL_CALL_END = "TOOL_CALL_END";
    public const string STATE_SNAPSHOT = "STATE_SNAPSHOT";
    public const string STATE_DELTA = "STATE_DELTA";
    public const string MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT";
    public const string RAW = "RAW";
    public const string CUSTOM = "CUSTOM";
    public const string RUN_STARTED = "RUN_STARTED";
    public const string RUN_FINISHED = "RUN_FINISHED";
    public const string RUN_ERROR = "RUN_ERROR";
    public const string STEP_STARTED = "STEP_STARTED";
    public const string STEP_FINISHED = "STEP_FINISHED";
}
