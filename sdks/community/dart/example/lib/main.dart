import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:ag_ui/ag_ui.dart';
import 'package:args/args.dart';
import 'package:http/http.dart' as http;

/// Tool Based Generative UI CLI Example
///
/// Demonstrates connecting to an AG-UI server, sending messages,
/// streaming events, and handling tool calls.
void main(List<String> arguments) async {
  final parser = ArgParser()
    ..addOption(
      'url',
      abbr: 'u',
      defaultsTo: Platform.environment['AG_UI_BASE_URL'] ?? 'http://127.0.0.1:20203',
      help: 'Base URL of the AG-UI server',
    )
    ..addOption(
      'api-key',
      abbr: 'k',
      defaultsTo: Platform.environment['AG_UI_API_KEY'],
      help: 'API key for authentication',
    )
    ..addOption(
      'message',
      abbr: 'm',
      help: 'Message to send (if not provided, will read from stdin)',
    )
    ..addFlag(
      'json',
      abbr: 'j',
      negatable: false,
      help: 'Output structured JSON logs',
    )
    ..addFlag(
      'dry-run',
      abbr: 'd',
      negatable: false,
      help: 'Print planned requests without executing',
    )
    ..addFlag(
      'auto-tool',
      abbr: 'a',
      negatable: false,
      help: 'Automatically provide tool results (non-interactive)',
    )
    ..addFlag(
      'help',
      abbr: 'h',
      negatable: false,
      help: 'Show help message',
    );

  ArgResults args;
  try {
    args = parser.parse(arguments);
  } catch (e) {
    // ignore: avoid_print
    print('Error: $e');
    // ignore: avoid_print
    print('');
    _printUsage(parser);
    exit(1);
  }

  if (args['help'] as bool) {
    _printUsage(parser);
    exit(0);
  }

  final cli = ToolBasedGenerativeUICLI(
    baseUrl: args['url'] as String,
    apiKey: args['api-key'] as String?,
    jsonOutput: args['json'] as bool,
    dryRun: args['dry-run'] as bool,
    autoTool: args['auto-tool'] as bool,
  );

  // Get message from args or stdin
  String? message = args['message'] as String?;
  if (message == null) {
    // ignore: avoid_print
    print('Enter your message (press Enter when done):');
    message = stdin.readLineSync();
    if (message == null || message.isEmpty) {
      // ignore: avoid_print
      print('No message provided');
      exit(1);
    }
  }

  try {
    await cli.run(message);
  } catch (e) {
    if (args['json'] as bool) {
      // ignore: avoid_print
      print(json.encode({'error': e.toString()}));
    } else {
      // ignore: avoid_print
      print('Error: $e');
    }
    exit(1);
  }
}

void _printUsage(ArgParser parser) {
  // ignore: avoid_print
  print('Tool Based Generative UI CLI Example');
  // ignore: avoid_print
  print('');
  // ignore: avoid_print
  print('Usage: dart run ag_ui_example [options]');
  // ignore: avoid_print
  print('');
  // ignore: avoid_print
  print('Options:');
  // ignore: avoid_print
  print(parser.usage);
  // ignore: avoid_print
  print('');
  // ignore: avoid_print
  print('Examples:');
  // ignore: avoid_print
  print('  # Interactive mode with default server');
  // ignore: avoid_print
  print('  dart run ag_ui_example');
  // ignore: avoid_print
  print('');
  // ignore: avoid_print
  print('  # Send a specific message');
  // ignore: avoid_print
  print('  dart run ag_ui_example -m "Create a haiku about AI"');
  // ignore: avoid_print
  print('');
  // ignore: avoid_print
  print('  # Auto-respond to tool calls');
  // ignore: avoid_print
  print('  dart run ag_ui_example -a -m "Create a haiku"');
  // ignore: avoid_print
  print('');
  // ignore: avoid_print
  print('  # JSON output for debugging');
  // ignore: avoid_print
  print('  dart run ag_ui_example -j -m "Test message"');
}

/// Main CLI implementation
class ToolBasedGenerativeUICLI {
  final String baseUrl;
  final String? apiKey;
  final bool jsonOutput;
  final bool dryRun;
  final bool autoTool;

  late final EventDecoder decoder;
  final Set<String> processedToolCallIds = {};

  ToolBasedGenerativeUICLI({
    required this.baseUrl,
    this.apiKey,
    this.jsonOutput = false,
    this.dryRun = false,
    this.autoTool = false,
  }) {
    decoder = EventDecoder();
  }

  Future<void> run(String message) async {
    _log('info', 'Starting Tool Based Generative UI flow');
    _log('debug', 'Base URL: $baseUrl');

    // Generate IDs
    final threadId = 'thread_${DateTime.now().millisecondsSinceEpoch}';
    final runId = 'run_${DateTime.now().millisecondsSinceEpoch}';

    // Create initial message
    final userMessage = UserMessage(
      id: 'msg_${DateTime.now().millisecondsSinceEpoch}',
      content: message,
    );

    final input = RunAgentInput(
      threadId: threadId,
      runId: runId,
      state: {},
      messages: [userMessage],
      tools: [],
      context: [],
      forwardedProps: {},
    );

    if (dryRun) {
      _log('info', 'DRY RUN - Would send request:');
      _log('info', 'POST $baseUrl/tool-based-generative-ui');
      _log('info', 'Body: ${json.encode(input.toJson())}');
      return;
    }

    // Start the run
    _log('info', 'Starting run with thread_id: $threadId, run_id: $runId');
    _log('info', 'User message: $message');

    try {
      // Send initial request and stream events
      await _streamRun(input);
    } catch (e) {
      _log('error', 'Failed to complete run: $e');
      rethrow;
    }
  }

  Future<void> _streamRun(RunAgentInput input) async {
    final url = Uri.parse('$baseUrl/tool_based_generative_ui');
    
    // Prepare request
    final request = http.Request('POST', url)
      ..headers['Content-Type'] = 'application/json'
      ..headers['Accept'] = 'text/event-stream'
      ..body = json.encode(input.toJson());

    if (apiKey != null) {
      request.headers['Authorization'] = 'Bearer $apiKey';
    }

    _log('debug', 'Sending request to ${url.toString()}');

    // Send request and get streaming response
    final httpClient = http.Client();
    try {
      final streamedResponse = await httpClient.send(request);

      if (streamedResponse.statusCode != 200) {
        final body = await streamedResponse.stream.bytesToString();
        throw Exception('Server returned ${streamedResponse.statusCode}: $body');
      }

      // Process SSE stream
      final sseClient = SseClient();
      final sseStream = sseClient.parseStream(
        streamedResponse.stream,
        headers: streamedResponse.headers,
      );

      final allMessages = List<Message>.from(input.messages);
      final pendingToolCalls = <ToolCall>[];
      bool runCompleted = false;

      await for (final sseMessage in sseStream) {
        if (sseMessage.data == null || sseMessage.data!.isEmpty) {
          continue;
        }

        try {
          final event = decoder.decode(sseMessage.data!);
          runCompleted = await _handleEvent(event, allMessages, pendingToolCalls, input);
          if (runCompleted) {
            break; // Exit the stream loop when run is finished
          }
        } catch (e) {
          _log('error', 'Failed to decode event: $e');
          _log('debug', 'Raw data: ${sseMessage.data}');
        }
      }

      // After run completes, process any pending tool calls that haven't been processed yet
      if (runCompleted && pendingToolCalls.isNotEmpty) {
        final unprocessedToolCalls = pendingToolCalls
            .where((tc) => !processedToolCallIds.contains(tc.id))
            .toList();
        
        if (unprocessedToolCalls.isNotEmpty) {
          _log('info', 'Processing ${unprocessedToolCalls.length} pending tool calls');
          await _processToolCalls(unprocessedToolCalls, allMessages, input);
        } else {
          _log('info', 'All tool calls already processed, run complete');
        }
      }
    } finally {
      httpClient.close();
    }
  }

  Future<bool> _handleEvent(
    BaseEvent event,
    List<Message> allMessages,
    List<ToolCall> pendingToolCalls,
    RunAgentInput originalInput,
  ) async {
    _log('event', event.eventType.toString().split('.').last);

    switch (event.eventType) {
      case EventType.runStarted:
        final runStarted = event as RunStartedEvent;
        _log('info', 'Run started: ${runStarted.runId}');
        break;

      case EventType.messagesSnapshot:
        final snapshot = event as MessagesSnapshotEvent;
        allMessages.clear();
        allMessages.addAll(snapshot.messages);
        
        // Collect tool calls but DON'T process them yet
        for (final message in snapshot.messages) {
          if (message is AssistantMessage && message.toolCalls != null && message.toolCalls!.isNotEmpty) {
            for (final toolCall in message.toolCalls!) {
              // Check if we've already collected this tool call
              if (!pendingToolCalls.any((tc) => tc.id == toolCall.id)) {
                pendingToolCalls.add(toolCall);
                _log('info', 'Tool call detected: ${toolCall.function.name} (will process after run completes)');
              }
            }
          }
        }
        
        // Display latest assistant message
        final latestAssistant = snapshot.messages
            .whereType<AssistantMessage>()
            .lastOrNull;
        if (latestAssistant != null) {
          if (latestAssistant.content != null) {
            _log('assistant', latestAssistant.content!);
          }
        }
        break;

      case EventType.runFinished:
        final runFinished = event as RunFinishedEvent;
        _log('info', 'Run finished: ${runFinished.runId}');
        return true; // Signal that the run is complete

      default:
        _log('debug', 'Unhandled event type: ${event.eventType}');
    }
    return false; // Run is not complete yet
  }

  Future<void> _processToolCalls(
    List<ToolCall> toolCalls,
    List<Message> allMessages,
    RunAgentInput originalInput,
  ) async {
    if (toolCalls.isEmpty) return;

    // Process each tool call and collect results
    for (final toolCall in toolCalls) {
      _log('info', 'Processing tool call: ${toolCall.function.name}');
      _log('debug', 'Arguments: ${toolCall.function.arguments}');

      String toolResult;
      if (autoTool) {
        // Auto-generate tool result
        toolResult = _generateAutoToolResult(toolCall);
        _log('info', 'Auto-generated tool result: $toolResult');
      } else {
        // Prompt user for tool result
        // ignore: avoid_print
        print('\nTool "${toolCall.function.name}" was called with:');
        // ignore: avoid_print
        print(toolCall.function.arguments);
        // ignore: avoid_print
        print('Enter tool result (or press Enter for default):');
        final userInput = stdin.readLineSync();
        toolResult = userInput?.isNotEmpty == true ? userInput! : 'thanks';
      }

      // Add tool result message
      final toolMessage = ToolMessage(
        id: 'msg_tool_${DateTime.now().millisecondsSinceEpoch}',
        content: toolResult,
        toolCallId: toolCall.id,
      );
      allMessages.add(toolMessage);
      
      // Mark this tool call as processed
      processedToolCallIds.add(toolCall.id);
    }

    // Send a new request with all tool results
    final newRunId = 'run_${DateTime.now().millisecondsSinceEpoch}';
    final updatedInput = RunAgentInput(
      threadId: originalInput.threadId,
      runId: newRunId,  // Use a new run ID for the tool response
      state: originalInput.state,
      messages: allMessages,
      tools: originalInput.tools,
      context: originalInput.context,
      forwardedProps: originalInput.forwardedProps,
    );

    if (!dryRun) {
      _log('info', 'Sending tool response(s) to server with new run...');
      await _streamRun(updatedInput);
    }
  }

  String _generateAutoToolResult(ToolCall toolCall) {
    // Generate deterministic tool results based on function name
    switch (toolCall.function.name) {
      case 'generate_haiku':
        return 'thanks';
      case 'get_weather':
        return json.encode({'temperature': 72, 'condition': 'sunny'});
      case 'calculate':
        return json.encode({'result': 42});
      default:
        return 'Tool executed successfully';
    }
  }

  void _log(String level, String message) {
    if (jsonOutput) {
      // ignore: avoid_print
      print(json.encode({
        'timestamp': DateTime.now().toIso8601String(),
        'level': level,
        'message': message,
      }));
    } else {
      final prefix = level == 'error'
          ? '❌'
          : level == 'info'
              ? '📍'
              : level == 'event'
                  ? '📨'
                  : level == 'assistant'
                      ? '🤖'
                      : level == 'debug'
                          ? '🔍'
                          : '  ';
      if (level != 'debug' || Platform.environment['DEBUG'] == 'true') {
        // ignore: avoid_print
        print('$prefix $message');
      }
    }
  }
}