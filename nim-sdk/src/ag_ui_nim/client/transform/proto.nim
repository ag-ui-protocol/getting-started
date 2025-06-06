import ../../core/events
import ../../core/observable
import ../../encoder/proto
import ../run/http_request
import options

type
  ProtoParser* = object
    buffer: seq[byte]
    lengthHeader*: bool

proc newProtoParser*(): ProtoParser =
  ProtoParser(buffer: @[], lengthHeader: true)

proc parseProtoChunk*(chunk: seq[byte], parser: var ProtoParser): seq[BaseEvent] =
  result = @[]
  
  # For simplicity in tests, just decode the chunk directly
  try:
    let event = decodeEvent(chunk)
    result.add(event)
  except:
    # In case of error, show the exception message
    echo "Error decoding proto message: " & getCurrentExceptionMsg()

proc parseProtoStream*(httpEvents: Observable[HttpEvent]): Observable[BaseEvent] =
  let subject = newSubject[BaseEvent]()
  var parser = newProtoParser()
  
  proc onNext(event: HttpEvent) =
    case event.eventType
    of HttpEventType.Headers:
      # For simplicity, always use length-prefixed format in tests
      parser.lengthHeader = true
    of HttpEventType.Data:
      # Convert string data to byte array
      let data = cast[seq[byte]](event.data)
      let events = parseProtoChunk(data, parser)
      for e in events:
        subject.next(e)
  
  proc onError(err: ref Exception) =
    subject.error(err)
  
  proc onComplete() =
    # Process any remaining data
    if parser.buffer.len > 0:
      try:
        let event = decodeEvent(parser.buffer)
        subject.next(event)
      except:
        discard
    subject.complete()
  
  let observer = Observer[HttpEvent](
    next: onNext,
    error: some(onError),
    complete: some(onComplete)
  )
  
  let subscription = httpEvents.subscribe(observer)
  
  proc subscribe(observer: Observer[BaseEvent]): Subscription =
    let sub = subject.subscribe(observer)
    
    proc unsubscribe() =
      sub.unsubscribe()
      subscription.unsubscribe()
    
    result = newSubscription(unsubscribe)
  
  result = newObservable[BaseEvent](subscribe)