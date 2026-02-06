---
title: sync.Pool 是怎么实现的？
published: 2026-02-06
description: 都说 sync.Pool 是无锁并发访问的，你知道原理吗？
tags:
  - Golang
  - 并发原语
  - 源码解读
category: 技术分享
draft: true
---
前几天看见一个技术交流群有关于 sync.Pool 的交流，问他是如何做到无锁并发访问的，我对这个问题比较有兴趣，就去看了它的源码一探究竟。

## sync.Pool 是什么？

简单来说就是一个对象复用池，当我们有需要频繁创建销毁对象的时候，就可以用上他来减少开销，它提供的主要 API 有 `Get` 和 `Put`，一个简单的例子：
```go
var bufPool = sync.Pool{
	New: func() any {
		return new(bytes.Buffer)
	},
}

func doSomething() []byte {
	b := bufPool.Get().(*bytes.Buffer)
	b.Reset()            // 清理旧内容
	defer bufPool.Put(b) // 用完放回

	b.WriteString("hello")
	return append([]byte(nil), b.Bytes()...)
}
```
我们通过声明创建一个 bufPool 的对象，此时所有的 goroutine 都可以去并发地去调用它，并且不需要加锁，下面我们可以看看他是如何做到的内部无锁也能保证原子性。

## Get 方法如何实现的？

首先我们可以来看看他的 `Get` 方法，相对我们以前读过的调度器或者垃圾回收来说真就是小朋友级别了，先把源代码贴出来：
```go
func (p *Pool) Get() any {
    ...
    // 拿到对应的本地 shard（l）以及 pid，同时 pin 就是将 g 绑定到 p 上，此时 p 上暂时不会发生协程切换。
    l, pid := p.pin()

    // 先尝试从该 P 的 private 获取，相当于是做了一个加速，类似 p 的 runnext。
    x := l.private
    l.private = nil

    if x == nil {
        // 从本地对象池的队头获取
        x, _ = l.shared.popHead()

        // 没有从本地的 p 所持有的缓存块获取到，从其他的 p 对象池的队尾窃取。
        if x == nil {
            x = p.getSlow(pid)
        }
    }

    // 解除与 P 的绑定。
    runtime_procUnpin()
	...
    // 如果最终还是 nil，并且用户提供了 New 函数，就用 New 生成一个新对象。
    if x == nil && p.New != nil {
        x = p.New()
    }
    return x
}
```
总体逻辑注释已经介绍地差不多了，首先是我们会调用 `pin` 方法，他会获取到我们的 p 当前的 m 对象，并且将他的 locks 成员 ++，这个成员很关键，我们在很多协程抢占、调度的位置都会去检查这个锁定位，如果锁定了，此时的 goroutine 就不会让出我们的线程资源，从而达到了绑定的效果。

随后我们的 `pin` 方法会从 Pool 的对象池里面通过 p 的 id 去从 p 的全局数组里面找到对应的对象池，其实就是通过 pid 进行资源的分片访问，这样的话，我们在单一 p 上的资源是只有一个 p 上的 g 会进行访问，并且此时我们的 g 是没办法切换的，所以在我们 `pin` 到 `unpin` 的这个时间段，有且仅有一个 g 会去访问这个 p 的对象池的资源，所以这样看来确实无锁就能实现安全的并发读写。
```go
func (p *Pool) pin() (*poolLocal, int) {
	if p == nil {
		panic("nil Pool")
	}

	// 就是 p.mp.locks ++
	pid := runtime_procPin()

	s := runtime_LoadAcquintptr(&p.localSize)

	l := p.local
	
	// 这里检查的是 pool 是否为足够的 p 分配了空间
	if uintptr(pid) < s {
		// 如果是，直接在 pool 的数组里面找到 p 对应的对象池
		return indexLocal(l, pid), pid
	}

	// 否则走慢路径，从其他 p 的对象池窃取或者走 Victim 机制
	return p.pinSlow()
}
```
慢路径就是从其他 p 的对象池的队尾进行窃取，这里不从队头窃取的原因之一是避免和当前正在窃取的队列的 p 发生冲突，注意，这里会和其他也在窃取这个队列的 p 发生冲突，当这个 p 的对象池队头遇到队尾也会有冲突，之后我们会讲；如果没有窃取到一块对象池，就会尝试用 victim 机制加载对象池，否则直接返回 nil：
```go
func (p *Pool) getSlow(pid int) any {
	size := runtime_LoadAcquintptr(&p.localSize)
	locals := p.local

	// 尝试从其他 P 的对象池里面去窃取一个对象
	for i := 0; i < int(size); i++ {
		l := indexLocal(locals, (pid+i+1)%int(size))

		// 这里是从队尾窃取，不是队头，减少和其他 p 的冲突
		if x, _ := l.shared.popTail(); x != nil {
			return x
		}
	}

	// victim 机制，后面会讲
	size = atomic.LoadUintptr(&p.victimSize)
	if uintptr(pid) >= size {
		return nil
	}

	locals = p.victim
	l := indexLocal(locals, pid)

	if x := l.private; x != nil {
		l.private = nil
		return x
	}
	for i := 0; i < int(size); i++ {
		l := indexLocal(locals, (pid+i)%int(size))
		if x, _ := l.shared.popTail(); x != nil {
			return x
		}
	}

	atomic.StoreUintptr(&p.victimSize, 0)

	return nil
}
```
是的，这里返回了 nil，在我们上面的逻辑可以知道，在检测到获取的对象为 nil 的时候，就会通过我们传入的 `New` 方法去创建一块新的内存，之后我们将这块 `New` 出来的对象还会通过 `Put` 放回队列，那个时候也有很多有意思的处理。

这里我们先提及我们底层的这个队列的并发安全操作是如何实现的吧，首先我们这里主要是 `popTail` 和 `popHead` 这两个方法。
```go
func (c *poolChain) popHead() (any, bool) {
	d := c.head

	// 遍历查找
	for d != nil {
		// 先从当前双端队列的头部弹出一个元素
		if val, ok := d.popHead(); ok {
			return val, ok
		}

		// 这个队列为空了，找下一个
		d = d.prev.Load()
	}

	return nil, false
}
```
还得往下翻，当前 p 的对象池是个链表，链表的元素是个双端队列，也就是个数组，现在只需要看看这个数组里面是如何实现并发安全的就行了，其实就是个 CAS 原子操作）
```go
func (d *poolDequeue) popHead() (any, bool) {
	var slot *eface
	for {
		// 原子读取 head/tail 的打包值，因为 head 和 tail 都是 uint32
		// 打包之后就是一个 uint64，可以直接用于原子操作。
		// 这样既可以防止和窃取当前队列的协程发生冲突。
		ptrs := d.headTail.Load()
		head, tail := d.unpack(ptrs)

		if tail == head {
			return nil, false
		}

		head--
		ptrs2 := d.pack(head, tail)

		if d.headTail.CompareAndSwap(ptrs, ptrs2) {
			// 通过环形数组下标定位该 slot
			slot = &d.vals[head&uint32(len(d.vals)-1)]
			break
		}
		// CAS 失败说明 headTail 被别人改过（比如 popTail），重试
	}

	val := *(*any)(unsafe.Pointer(slot))

	if val == dequeueNil(nil) {
		val = nil
	}

	// 把 slot 清零。
	// 与 popTail 不同，这里不会和 pushHead 发生竞态（因为 popHead 只给单生产者用），
	// 所以可以直接清空，不需要特别小心内存顺序。
	*slot = eface{}

	return val, true
}
```
可以看见，其实就是将队头和队尾的 index 值打包成一个 uint64 的数字来实现 CAS 原子操作保证操作队头和队尾是并发安全的，同时由于这里队头一般只会由一个 p 进行操作，所以这里的 slot 可以无锁安全操作的。

下面来看看我们的队尾是如何操作的：
## Put 方法如何实现的？
其实从我们最开始的示例代码就可以知道，我们最开始没有为 `p.local` 或者 `p.localsize` 赋值的，这当然是在 sync.Pool 的考虑范围之内，当我们第一次执行 Get 的时候，内存池完全是空的，他会通过 `New` 来创建一个新的对象，之后我们调用 `Put` 归还这个对象的时候，如果此时内存池依旧是空的，就会走慢路径为我们初始化内存池：

## 其他一些优化机制


## 总结