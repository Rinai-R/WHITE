---
title: sync.Pool 是怎么实现的？
published: 2026-02-06
description: 都说 sync.Pool 是无锁并发访问的，你知道原理吗？
tags:
  - Golang
  - 并发原语
  - 源码解读
category: 技术分享
draft: false
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

	// 否则走慢路径，这里会初始化
	return p.pinSlow()
}
```
我们可以去仔细看看 `pinSlow` 方法，其实从我们最开始的示例代码就可以知道，我们最开始没有为 `p.local` 或者 `p.localsize` 赋值的，这当然是在 sync.Pool 的考虑范围之内，当我们第一次执行 Get 的时候，内存池完全是空的，就会走慢路径为我们初始化内存池：
```go
func (p *Pool) pinSlow() (*poolLocal, int) {
	// 处于 pin 状态不能去执行 lock，先 unpin
	runtime_procUnpin()

	// 所有 Pool 的全局锁：保护 allPools
	allPoolsMu.Lock()
	defer allPoolsMu.Unlock()

	// 重新 pin，现在是安全的
	pid := runtime_procPin()

	s := p.localSize
	l := p.local

	// 看看之前 unpin 到加锁这段期间可能已经被初始化好了。
	if uintptr(pid) < s {
		return indexLocal(l, pid), pid
	}

	// 这里说明当前 pid 超出 localSize，说明 local 尚未初始化或 GOMAXPROCS 变大导致不够用

	if p.local == nil {
		// 第一次初始化该 Pool：把它加入 allPools，
		allPools = append(allPools, p)
	}

	// local 数组大小按当前 GOMAXPROCS 分配，
	// 每个 P 一个 poolLocal，减少竞争。
	size := runtime.GOMAXPROCS(0)

	// 分配新的 poolLocal 数组
	local := make([]poolLocal, size)

	atomic.StorePointer(&p.local, unsafe.Pointer(&local[0]))
	runtime_StoreReluintptr(&p.localSize, uintptr(size)) 

	// 返回当前 pid 对应池子槽位
	return &local[pid], pid
}
```
此时当然已经初始化完了，但是我们的 local 池子里面的链表还是空的，所以此时还是会走慢路径，如果慢路径也没有窃取到，则会走 `New` 去初始化新的对象。

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
是的，这里返回了 nil，在我们上面的逻辑可以知道，在检测到获取的对象为 nil 的时候，就会通过我们传入的 `New` 方法去创建一块新的内存，之后我们将这块 `New` 出来的对象还会通过 `Put` 放回队列。

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

其实我们的队尾整体上也是一样的原理，但是他在检测到队尾某个数组节点为空时，需要通过 CAS 原子切换队尾的元素，保证每次正确得到有元素的队尾节点开始窃取。这里就不再赘述了。

## Put 方法如何实现的？

直接上代码：
```go
func (p *Pool) Put(x any) {
	...
	
	// 依旧绑定 g 到 p 上，并得到 p 在 pool 里面的对应的对象池链表
	l, _ := p.pin()
	if l.private == nil {
		// 快速路径
		l.private = x
	} else {
		// 直接走 pushHead
		l.shared.pushHead(x)
	}
	runtime_procUnpin()
	if race.Enabled {
		race.Enable()
	}
}
```
`pin` 方法都是一样的，后面干的第一件事就是检查快速路径的 `private` 位置，否则直接走 `pushHead` 从队头推入对象，这里我们可以知道，p 对应的对象池队头在同一时刻总是只有一个 g 进行操作，所以这里是相对比较安全的，但是也要注意和队尾的窃取的竞争问题。

下面来看看 `pushHead` 的实现：
```go
func (c *poolChain) pushHead(val any) {
	// 取当前链表头结点
	d := c.head
	if d == nil {
		// 第一次插入：初始化整个 chain（只有一个 deque 节点）
		const initSize = 8
		d = new(poolChainElt)
		d.vals = make([]eface, initSize)
		c.head = d
		c.tail.Store(d)
	}

	// 尝试直接往当前 head 节点的头部入队
	// pushHead 返回 true 表示成功
	if d.pushHead(val) {
		return
	}
	
	// 扩容，需要新建一个 head
	newSize := len(d.vals) * 2
	if newSize >= dequeueLimit {
		newSize = dequeueLimit
	}

	// 新建链表头节点 d2
	d2 := &poolChainElt{}
	d2.prev.Store(d)
	d2.vals = make([]eface, newSize)

	// 把新节点设置为 head，并把旧 head 的 next 指向新 head
	c.head = d2
	d.next.Store(d2) // 原子写 next，这里主要是防止和队尾产生冲突

	// 新 head 肯定是空的，把元素 push 进去
	d2.pushHead(val)
}

```
到了这里，其实我们可以发现，我们第一次调用 `Get` 或者 `Put` 都是一个懒加载的策略，在 `pin` 的时候才会真正地去根据 GOMAXPROCS 的数量去分配对象池的空间，第一次 Put 的时候，才会真正给对象池的链表头分配空间。

这里的 `pushHead` 其实相比之下是比较无趣的，他和 `popHead` 实现也是大差不差，这里不再赘述。

我们可以小结一下，通过传入一个 `New` 函数来指定这个对象池里面存放的元素，之后我们第一次从中 `Get` 肯定是没办法从对象池里面拿到任何数据的，只能通过 `New` 去新分配对象，直到我们尝试往里面 `Put` 对象，他就会缓存到这个 p 的对象池里面了，并且他是可以被其他 p 从队尾窃取的。那么回到最初的问题，他是如何实现无锁访问的？首先他是通过 pid 进行分片，让每个 p 上的 g 可以在 `pin` 之后能够安全的访问本地对象池，但是这里如果是从对象池队列里面访问数据的话，是需要和队尾的窃取 goroutine 竞争的，这里通过 CAS 操作解决了这个问题。当然，我们的 `sync.Pool` 他并不是完全无锁的，我们所有的初始化的 sync.Pool 都需要加入全局的 Pool 数组，原因之后会说，如果需要访问这个全局的 Pool 数组就需要通过加一个全局锁来访问了。

下面介绍一些我们之前提过的，但是没有详细说的优化机制。

## 其他一些优化机制

### victim 机制

我们之前在 `getSLow` 的方法里面看见过 `sync.Pool` 的一个字段叫做 `victim`，这里和我们的垃圾回收有关，在垃圾回收期间，我们会将 `sync.Pool` 里面的对象进行清理，如果不进行清理就可能会导致内存问题，但是如果直接进行清理就意味着我们每个 p 的本地缓存就没了，如果当前的 pool 是热点数据，就会直接导致程序性能下降，为了应对这个问题，就引入了 `victim` 机制。

在进行垃圾回收的时候，会将当前的对象池存入 `sync.Pool` 的 `victim` 对象，而将 `local` 置为 nil，当我们之后执行 `Get` 的时候，如果发现 `local` 没有数据，会尝试走慢路径，这里包括窃取和走 `victim`，我们此时可以直接同 `victim` 里面获取对象，于是就不需要走 `New` 方法了，并且之后我们在执行 `Put` 归还这个对象的时候，也是归还到 `local` 里面，可以近似看成一个渐进式迁移的策略。

如果当前的 `sync.Pool` 调用比较频繁，那么之前在里面缓存的对象可以很快地被迁移到新的 `local` 里面，如果调用比较少，那么 `victim` 成员里面的数据基本不会被迁移，在下一轮 GC 中，就会取消对它的引用，从而能够被 GC 给回收掉，这样在性能和减少内存占用上取得了平衡。

### cache line 优化

我们可以观察，每一个 sync.Pool 关于 p 的本地缓存的结构体如下：
```go
type poolLocalInternal struct {
	private any 
	shared  poolChain
}

type poolLocal struct {
	poolLocalInternal

	// Prevents false sharing on widespread platforms with
	// 128 mod (cache line size) = 0 .
	pad [128 - unsafe.Sizeof(poolLocalInternal{})%128]byte
}
```
这里的 pad 成员我们并没有看见它的使用，通过注释我们可以知道，这是一个关于 cacheline 的优化策略，pad 的作用就是将 `poolLocal` 的大小补齐到 128 个字节对齐，大部分 CPU Cacheline 的大小是 64 字节，这样可以覆盖常见的甚至 CPU Cacheline 更宽的情况，从而避免了两个 p 的本地对象池落在同一个 Cacheline 的伪共享情况，至于什么是伪共享并不是本文的重点，可以参考 [小林 coding](https://www.xiaolincoding.com/os/1_hardware/how_cpu_deal_task.html) 感觉他的图是讲得比较清晰的。

## 总结

总的来讲，sync.Pool 的源码是非常简短的，但是他在设计上也有很多值得我们注意和学习的点，比如如何并发无锁访问、victim 机制、如何避免伪共享问题，这些都是很有意思的知识。