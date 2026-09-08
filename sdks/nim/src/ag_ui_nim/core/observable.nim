import std/[asyncdispatch, options, tables]

type
  Subscription* = ref object of RootObj
    id: int
    unsubscribe*: proc () {.closure.}

  NextFunc*[T] = proc(value: T) {.closure.}
  ErrorFunc* = proc(err: ref Exception) {.closure.}
  CompleteFunc* = proc() {.closure.}
  
  Observer*[T] = object
    next*: NextFunc[T]
    error*: Option[ErrorFunc]
    complete*: Option[CompleteFunc]
  
  SubscribeProc*[T] = proc(observer: Observer[T]): Subscription {.closure.}
  
  Observable*[T] = ref object of RootObj
    subscribe*: SubscribeProc[T]
  
  Subject*[T] = ref object of Observable[T]
    observers*: Table[int, Observer[T]]
    stopped*: bool
    error*: Option[ref Exception]
    nextId*: int

var globalSubscriptionId = 0

proc newSubscription*(unsubscribe: proc() {.closure.}): Subscription =
  result = Subscription(
    id: globalSubscriptionId,
    unsubscribe: unsubscribe
  )
  inc globalSubscriptionId

proc newObservable*[T](subscribe: SubscribeProc[T]): Observable[T] =
  result = Observable[T](subscribe: subscribe)

proc map*[T, U](source: Observable[T], f: proc(t: T): U {.closure.}): Observable[U] =
  proc subscribe(observer: Observer[U]): Subscription {.closure.} =
    proc onNext(value: T) =
      observer.next(f(value))
    
    let mappedObserver = Observer[T](
      next: onNext,
      error: if observer.error.isSome: some(observer.error.get()) else: none(ErrorFunc),
      complete: if observer.complete.isSome: some(observer.complete.get()) else: none(CompleteFunc)
    )
    
    result = source.subscribe(mappedObserver)
  
  result = newObservable[U](subscribe)

proc filter*[T](source: Observable[T], predicate: proc(t: T): bool {.closure.}): Observable[T] =
  proc subscribe(observer: Observer[T]): Subscription {.closure.} =
    proc onNext(value: T) =
      if predicate(value):
        observer.next(value)
    
    let filteredObserver = Observer[T](
      next: onNext,
      error: if observer.error.isSome: some(observer.error.get()) else: none(ErrorFunc),
      complete: if observer.complete.isSome: some(observer.complete.get()) else: none(CompleteFunc)
    )
    
    result = source.subscribe(filteredObserver)
  
  result = newObservable[T](subscribe)

proc merge*[T](sources: varargs[Observable[T]]): Observable[T] =
  proc subscribe(observer: Observer[T]): Subscription {.closure.} =
    var subscriptions: seq[Subscription] = @[]
    
    for source in sources:
      subscriptions.add(source.subscribe(observer))
    
    proc unsubscribeAll() =
      for sub in subscriptions:
        sub.unsubscribe()
    
    result = newSubscription(unsubscribeAll)
  
  result = newObservable[T](subscribe)

proc newSubject*[T](): Subject[T] =
  var subject = Subject[T](
    observers: initTable[int, Observer[T]](),
    stopped: false,
    error: none(ref Exception),
    nextId: 0
  )
  
  proc subscribe(observer: Observer[T]): Subscription {.closure.} =
    if subject.stopped:
      if subject.error.isSome:
        if observer.error.isSome:
          observer.error.get()(subject.error.get())
      elif observer.complete.isSome:
        observer.complete.get()()
      return newSubscription(proc() = discard)
    
    let id = subject.nextId
    inc subject.nextId
    subject.observers[id] = observer
    
    proc unsubscribe() =
      if subject.observers.hasKey(id):
        subject.observers.del(id)
    
    newSubscription(unsubscribe)
  
  subject.subscribe = subscribe
  return subject

proc next*[T](subject: Subject[T], value: T) =
  if subject.stopped:
    return
  
  var keys = newSeq[int]()
  for id in subject.observers.keys:
    keys.add(id)
  
  for id in keys:
    subject.observers[id].next(value)

proc error*[T](subject: Subject[T], err: ref Exception) =
  if subject.stopped:
    return
  
  subject.error = some(err)
  subject.stopped = true
  
  var keys = newSeq[int]()
  for id in subject.observers.keys:
    keys.add(id)
  
  for id in keys:
    if subject.observers[id].error.isSome:
      subject.observers[id].error.get()(err)
  
  subject.observers.clear()

proc complete*[T](subject: Subject[T]) =
  if subject.stopped:
    return
  
  subject.stopped = true
  
  var keys = newSeq[int]()
  for id in subject.observers.keys:
    keys.add(id)
  
  for id in keys:
    if subject.observers[id].complete.isSome:
      subject.observers[id].complete.get()()
  
  subject.observers.clear()

# Asynchronous observable utilities
proc fromAsync*[T](asyncProc: proc(): Future[T] {.async.}): Observable[T] =
  proc subscribe(observer: Observer[T]): Subscription {.closure.} =
    let future = asyncProc()
    
    proc checkResult() {.async.} =
      try:
        let value = await future
        observer.next(value)
        if observer.complete.isSome:
          observer.complete.get()()
      except Exception as e:
        if observer.error.isSome:
          observer.error.get()(e)
    
    discard checkResult()
    
    proc unsubscribe() =
      if not future.finished:
        future.cancel()
    
    result = newSubscription(unsubscribe)
  
  result = newObservable[T](subscribe)

proc fromSequence*[T](sequence: seq[T]): Observable[T] =
  proc subscribe(observer: Observer[T]): Subscription {.closure.} =
    for item in sequence:
      observer.next(item)
    
    if observer.complete.isSome:
      observer.complete.get()()
    
    proc unsubscribe() = discard
    result = newSubscription(unsubscribe)
  
  result = newObservable[T](subscribe)

proc takeUntil*[T, S](source: Observable[T], notifier: Observable[S]): Observable[T] =
  proc subscribe(observer: Observer[T]): Subscription {.closure.} =
    var sourceSub: Subscription
    
    let notifierObs = Observer[S](
      next: proc(value: S) =
        if sourceSub != nil:
          sourceSub.unsubscribe()
        if observer.complete.isSome:
          observer.complete.get()(),
      error: proc(err: ref Exception) =
        if observer.error.isSome:
          observer.error.get()(err)
    )
    
    let notifierSub = notifier.subscribe(notifierObs)
    
    sourceSub = source.subscribe(observer)
    
    proc unsubscribe() =
      sourceSub.unsubscribe()
      notifierSub.unsubscribe()
    
    result = newSubscription(unsubscribe)
  
  result = newObservable[T](subscribe)

proc scan*[T, R](source: Observable[T], seed: R, accumulator: proc(acc: R, value: T): R {.closure.}): Observable[R] =
  proc subscribe(observer: Observer[R]): Subscription {.closure.} =
    var acc = seed
    
    proc onNext(value: T) =
      acc = accumulator(acc, value)
      observer.next(acc)
    
    let scanObserver = Observer[T](
      next: onNext,
      error: if observer.error.isSome: some(observer.error.get()) else: none(ErrorFunc),
      complete: if observer.complete.isSome: some(observer.complete.get()) else: none(CompleteFunc)
    )
    
    result = source.subscribe(scanObserver)
  
  result = newObservable[R](subscribe)