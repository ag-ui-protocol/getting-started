import unittest
import ag_ui_nim
import sequtils

proc testObservable() =
  test "Observable should support basic subscribe/next/complete":
    var values: seq[int] = @[]
    var completed = false
    
    proc subscribe(observer: Observer[int]): Subscription {.closure.} =
      observer.next(1)
      observer.next(2)
      observer.next(3)
      if observer.complete.isSome:
        observer.complete.get()()
      result = newSubscription(proc() = discard)
    
    let observable = newObservable[int](subscribe)
    
    proc onNext(x: int) = values.add(x)
    proc onComplete() = completed = true
    
    let observer = Observer[int](
      next: onNext,
      complete: some(onComplete)
    )
    
    discard observable.subscribe(observer)
    
    check(values == @[1, 2, 3])
    check(completed)
  
  test "Observable map operator":
    var values: seq[string] = @[]
    
    proc subscribe(observer: Observer[int]): Subscription {.closure.} =
      observer.next(1)
      observer.next(2)
      observer.next(3)
      if observer.complete.isSome:
        observer.complete.get()()
      result = newSubscription(proc() = discard)
    
    let source = newObservable[int](subscribe)
    let mapped = source.map(proc(x: int): string = $x & "!")
    
    proc onNext(x: string) = values.add(x)
    
    let observer = Observer[string](
      next: onNext
    )
    
    discard mapped.subscribe(observer)
    
    check(values == @["1!", "2!", "3!"])
  
  test "Observable filter operator":
    var values: seq[int] = @[]
    
    proc subscribe(observer: Observer[int]): Subscription {.closure.} =
      observer.next(1)
      observer.next(2)
      observer.next(3)
      observer.next(4)
      if observer.complete.isSome:
        observer.complete.get()()
      result = newSubscription(proc() = discard)
    
    let source = newObservable[int](subscribe)
    let filtered = source.filter(proc(x: int): bool = x mod 2 == 0)
    
    proc onNext(x: int) = values.add(x)
    
    let observer = Observer[int](
      next: onNext
    )
    
    discard filtered.subscribe(observer)
    
    check(values == @[2, 4])
  
  test "Subject should allow multiple subscribers":
    var values1: seq[int] = @[]
    var values2: seq[int] = @[]
    
    let subject = newSubject[int]()
    
    proc onNext1(x: int) = values1.add(x)
    proc onNext2(x: int) = values2.add(x)
    
    let observer1 = Observer[int](next: onNext1)
    let observer2 = Observer[int](next: onNext2)
    
    let sub1 = subject.subscribe(observer1)
    let sub2 = subject.subscribe(observer2)
    
    subject.next(1)
    subject.next(2)
    
    sub1.unsubscribe()  # First subscriber unsubscribes
    
    subject.next(3)  # Only second subscriber should receive this
    
    check(values1 == @[1, 2])
    check(values2 == @[1, 2, 3])
  
  test "Subject should handle error and complete":
    var values: seq[int] = @[]
    var hasError = false
    var completed = false
    
    let subject = newSubject[int]()
    
    proc onNext(x: int) = values.add(x)
    proc onError(err: ref Exception) = hasError = true
    proc onComplete() = completed = true
    
    let observer = Observer[int](
      next: onNext,
      error: some(onError),
      complete: some(onComplete)
    )
    
    discard subject.subscribe(observer)
    
    subject.next(1)
    subject.complete()
    subject.next(2)  # Should be ignored after complete
    
    check(values == @[1])
    check(completed)
    check(not hasError)
    
    # Create a new subject to test error
    let errorSubject = newSubject[int]()
    discard errorSubject.subscribe(observer)
    
    errorSubject.next(3)
    errorSubject.error(newException(ValueError, "Test error"))
    errorSubject.next(4)  # Should be ignored after error
    
    check(values == @[1, 3])
    check(hasError)

when isMainModule:
  testObservable()