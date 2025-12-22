---
title: Go 的调度模型
published: 2025-12-21
description: G、M、P 及其牵扯到的各种应用绝对是 Go 语言最核心，最复杂的部分。
image: ./2025-12-20.png
tags:
  - Golang
  - 调度器
category: 技术分享
draft: false
---
## 前言

我们都知道 GMP 模型，也知道经典的 `schedule` 函数的大体步骤，但是隐藏在 g、m、p 这三个结构体之后的还有更加有趣的细节。

## Go 程序的启动以及 GMP 的初始化

抛开 gmp 不谈，Go 在启动之初只是在一步一步执行汇编代码，首先初始化好了 m0 和 g0，之后执行初始化逻辑都是在 m0 和 g0 上面执行的，然后将写在 `runtime` 中的 main 函数传入 `newproc` 创建第一个 goroutine 并放入 p 的执行队列，除开我们当前的 g0 之外，此时已经有了一个 g，随后执行 `mstart` 最终会进入到调度循环，开始调度最开始 `newproc` 创建的 goroutine，此时会开始执行 `runtime.main` 而不是 `main.main`，所谓的 `main.main` 会通过 linkname 去拉取我们自己实现的 main 函数，而在 `runtime.main` 会经过一些初始化，最后才会执行我们的 main.main，如果对 Go 程序的启动步骤好奇，可以看看[这边文章](https://chenbc.xlog.app/go-bootstrap)，我感觉这位大佬写得还是挺好的。

我们可以知道，随着程序的一步步初始化，我们的 gmp 模型才有了雏形，runtime 也并不是什么黑魔法，也是程序写出来的，但是我们还是需要注意一些 gmp 的初始化函数，比如 `schedinit` ：
```go
// 他会在 osinit 之后，newproc 之前调用。
func schedinit() {
	...
	// 设置M的最大数量，默认 10000 个。
	sched.maxmcount = 10000

	// The world starts stopped. (世界在启动之初是“停止”的)
	worldStopped()
	// 一系列初始化，包括但不限于 GC，堆栈内存分配初始化。
	...
	
	// 确定 procs 的数量。
	var procs int32
	if n, ok := strconv.Atoi32(gogetenv("GOMAXPROCS")); ok && n > 0 {
		procs = n // 优先使用GOMAXPROCS环境变量
		sched.customGOMAXPROCS = true
	} else {
		procs = defaultGOMAXPROCS(numCPUStartup) // 否则使用检测到的CPU核心数
	}

	// 根据 procs 的数量初始化所有的 p，并放在 allp 数组里面，
	// 里面包含全局的 p。
	if procresize(procs) != nil {
		throw("unknown runnable goroutine during bootstrap")
	}
	
	...
}
```
我们需要关心的部分只有 `procresize`，可以看看它是如何初始化 p 的，这对我们后面对 gmp 的理解很重要，虽然这个函数非常长，但是其中涉及到的扩缩容操作并不是我们当前所关心的，我们只想要知道，p 到底是咋初始化的，初始化了哪些资源？
```go
// 根据 nprocs 去调整 p 的数量，并对没有初始化的 p 进行初始化。
// 返回的是需要有待执行 g 的 p，在程序初始化的时候理所应当为空，所以非空时要抛出异常。
func procresize(nprocs int32) *p {
	...

	// 一般此时我们会经过这里，然后在这里初始化
	for i := old; i < nprocs; i++ {
		pp := allp[i]
		if pp == nil {
			pp = new(p)
		}
		// 真正的初始化操作
		pp.init(i)
		atomicstorep(unsafe.Pointer(&allp[i]), unsafe.Pointer(pp))
	}
	// 缩容操作啥的，不重要
	...
	
	// 这里一般会把没有运行队列（一般是刚初始化的 p）放入空闲队列
	for i := nprocs - 1; i >= 0; i-- {
		pp := allp[i]
		if gp.m.p.ptr() == pp {
			continue
		}
		pp.status = _Pidle
		if runqempty(pp) {
			pidleput(pp, now)
		} else {
			pp.m.set(mget())
			pp.link.set(runnablePs)
			runnablePs = pp
		}
	}
	...
	// 统计 allp 里面谁有待执行的 g，在 schedinit 阶段一定为空。
	return runnablePs
}
```
我们可以注意到，我们的 p 在 `init` 之后，由 `pidleput` 放入了空闲列表，而这个空闲列表正是我们程序准备完毕之后，gmp 的一个关键，随后我们可以进入到 `p.init` 这个方法：
```go
// 初始化 p
func (pp *p) init(id int32) {
	...
	pp.sudogcache = pp.sudogbuf[:0]
	
	pp.deferpool = pp.deferpoolbuf[:0]
	
	pp.wbBuf.reset()

	// 分配 mcache
	if pp.mcache == nil {
		if id == 0 {
			if mcache0 == nil {
				throw("missing mcache?") // 启动阶段 mcache0 必须存在。
			}
			// 使用引导阶段预先创建的 mcache0。
			// 只有一个 P 能得到 mcache0，那就是0号 P。
			// mcache0 是在 mallocinit 期间创建的，那时还没有 P。
			pp.mcache = mcache0
		} else {
			// 其他 p 调用 allocmcache() 分配一个新的 mcache。
			// mcache 是啥？可以看我的上篇文章。
			pp.mcache = allocmcache()
		}
	}
	...
}
```
我们可以看见，它仅仅是初始化了一些极少的资源，其中不涉及 m，也不涉及 g，这也就意味着，在之后我们创建一个新的 goroutine 之后，如果被调度到一个全新的 p 上，那么这个 p 必然需要去获取或者创建一个新的 m 才能正常执行这个 g，当然，之后在源码中我们一定会找到这部分的逻辑。

根据我们上面提到的 Go 程序的启动顺序，我们可以知道 `schedinit` 的下一步是通过 `newproc` 创建一个执行 `runtime.main` 函数的 goroutine，并将其放入当前 p 的执行队列，但是此时我们还没有去运行任何一个调度循环，无法去调度我们 p 本地队列中的 goroutine，所以之后我们会通过 `mstart` 去执行一系列操作，最终，调用大名鼎鼎的 `schedule` 去对我们队列中的 goroutine 进行调度。而这个所谓的 `newproc` 事实上就是我们 `go [函数调用]` 转换到运行时的函数调用：
```go
func newproc(fn *funcval) {
	...
	// systemstack 之前也提过，他会切换到 g0 的栈进行执行
	// g0 的栈，本质上其实就是由操作系统管理的线程在用户态执行代码的线程栈。
	// 它并不属于常规的 goroutine 栈，这个栈归操作系统管而不是 go 的运行时。
	systemstack(func() {
		// 1. 创建Goroutine结构体
		// newproc1是真正负责分配和初始化g结构体的函数。
		// 它会设置好新g的栈、起始PC（指向fn）、状态(_Grunnable)等。
		// fn: 新goroutine要执行的函数。
		// gp: 创建者goroutine。
		// pc: 创建位置。
		newg := newproc1(fn, gp, pc, false, waitReasonZero)

		// 获取当前的 p
		pp := getg().m.p.ptr()
		
		// 通过刚刚获取的 p，可以放到本地队列，如果 runnnext 槽位是空的
		// 就会放入 runnext 槽位，此时 schedule 在下一轮调度会执行这个函数，
		// 不然就正常放入 runq，
		// 当然，如果本地队列满了，那么就会包括这个 g 在内，取一部分 g 到全局队列
		runqput(pp, newg, true)
		
		// 在程序完成所有初始化之后，
		// 每次创建一个新的goroutine，都尝试唤醒一个可能在休眠的P。
		// 要求是此时没有正在自旋的 m（意思是此时足够空闲）
		// 有了它，每次启动一个协程都有可能启动一个 p，从而真正意义上的利用了多核的优势。
		if mainStarted {
			wakep()
		}
	})
}
```
虽然这里的 `newproc1` 和 `runqput` 看起来都很有意思，但是这并不是我们的重点，你只需要知道，`newproc1` 其实就是根据一系列参数创建了一个结构体，而 `runqput` 则是让这个 g 能够被 p 调度运行即可。这里虽然并不会执行，但是等到 `runtime.main` 执行过程中，`main.main` 开始之前，这个 `mainStart` 会标记为 true，之后每次启动一个 goroutine 都有可能唤醒我们之前初始化好的 p，然后让他去陷入 `schedule` 调度循环，进入到 `findRunnable` 去寻找可以执行的 g，他可能会去获取全局队列上的 g，也可能窃取其他队列上的 g，从而实现多个 p 的负载均衡。总之，有了这个，我们就能够充分的利用多核的优势，真正意义上的有多个 g-m-p 正在运行。

而我们当前处于 go 程序初始化的阶段，这里传入的 fn 参数的当然是 `runtime.main`，于是，我们可以知道，我们当前 p 的本地队列有一个待执行的 g 了！接下来，我们会调用 `mstart` 最终执行到 `schedule` 我们就能够看见真正的 gmp 调度了。而 `mstart` 其实是一段汇编代码，他会调用 `mstart0`，但是其实 `mstart0` 并没有什么值得注意的代码，我们可以直接看 `mstart1`：
```go
func mstart1() {
	...
	// 注册信号 handler
	if gp.m == &m0 {
		mstartm0()
	}

	...

	// 我们熟悉的 schedule 来了
	schedule()
}
```
其实我们当前只需要关注 `schedule` 这一个函数的执行即可，其余无关紧要，熟悉他的朋友都知道，他其实就是一个调度循环，会不断去寻找可运行的 g 去运行，现在不用关心他的逻辑，我们只需要知道现在我们可以执行 `runtime.main` 了！

当然，到了这里，事情并不会就这样简单的结束，在真正地调用 `main.main` 之前，还需要进行一些处理。
```go
// 之前提到的 linkname 拉模式
//go:linkname main_main main.main
func main_main()
...
// The main goroutine. (主goroutine执行的函数)
func main() {
	...
	// 允许 newproc 去唤醒休眠的 p，创建新的 m。
	mainStarted = true
	// 系统监控，专门启动一个线程去执行它
	// 系统监控没有 p，尽管有着 g0，但是他已经不归 go 的调度器管理了
	// 是一个纯粹的操作系统线程。
	if haveSysmon {
		systemstack(func() {
			newm(sysmon, nil, -1)
		})
	}
	...
	// runtime 的 init 函数
	doInit(runtime_inittasks)
	...
	// gcenable 会让 gc 正式开始工作
	gcenable()
	// cgo 相关初始化
	if iscgo {
		...
		// 通知Cgo，Go的运行时已经初始化完毕。
		cgocall(_cgo_notify_runtime_init_done, nil)
	}
	// 看到这里我非常惊讶，我们之前写的 init 函数都是在这里进行调用的
	for m := &firstmoduledata; m != nil; m = m.next {
		doInit(m.inittasks)
	}
	// 执行我们编写的 main
	fn := main_main
	
	fn()
	...
	// 清理工作
}
```
到这里，我们可以看见熟悉的 `init` 函数，熟悉的 `cgo` 还有熟悉的系统监控，以及的 `main.main` 的调用，不得不感叹，计算机的世界没有魔法。之后，在我们运行 main 函数的过程中，如果调用了 `go [函数调用]`，那么就会转换为 `newproc` 来创建一个新的 g，并放入待运行的队列中，随着程序的运行，g 的数量可能不断增多，它可能会被调度到其他 p 上，也可能会被放到全局队列上等待执行，毫无疑问的是，庞大的 GMP 帝国此时正在运转。（感觉自己像在写记叙文）

## 调度时机

虽然目前为止，我们对 GMP 的实现以及运转有了大体的认识，但是我们对于协作调度，抢占调度还是一无所知，有了 `schedule` 然后呢？它是如何在某个时刻停止运行这个 g，转而去运行下一个 g 的？针对于内核级线程这很简单，常见的调度算法就是时间片调度，只需要操作系统对硬件发出的时间片中断进行处理，进入到内核去运行下一个线程即可。那么我们的 goroutine 呢？由于他是在用户态实现的，并不能在进行系统调用的时候进行调度，也不能通过监听时间片中断来切换 goroutine 执行。Go 的 goroutine 调度不仅会通过 runtime 的一些安全点去检查抢占位来进行调度防止单个 g 运行过久，也会结合操作系统的信号机制来实现抢占式调度来尽可能地去保证公平调度。

其实几乎所有的调度最终都会通过 `schedule` 去找到下一个等待执行的 g 并运行，所以我们只需要在 `runtime` 找到调用 `schedule` 的地方就可以了。

### Gosched

`Gosched` 是一个主动让出线程资源的函数，除了我们自己编写代码的时候可以调用它以外，它也被许多运行时代码所调用，比如在 gc 期间分配内存会触发债务机制，如果当前 g 无法还清债务，会检查当前 g 的 `preempt` 标志位，即抢占请求位，此时会通过 `Gosched` 让出 m，如果没有抢占标志位，那么也会 `park` 当前 g 的执行，放到 `assistQueue` 队列里面，等待唤醒。（这个机制可以看我的 gc 文章）

### 基于协作的抢占式调度

我们常说的抢占调度点有一个函数调用，其实本质上是在栈扩张时，会调用 `newstack` ，其中会有一个抢占位的检查，检查当前的 g 是否应该被抢占，当然，这里关于栈的操作并不是我们的重点，我们关注的是抢占：
```go
//go:nowritebarrierrec
func newstack() {
	...

	// 这个字段可能会由系统监控和 GC 修改。
	stackguard0 := atomic.Loaduintptr(&gp.stackguard0)

	// 有没有抢占请求
	preempt := stackguard0 == stackPreempt
	
	if preempt {
		// 有一些情况导致不满足安全点导致无法抢占
		if !canPreemptM(thisg.m) {
			// 恢复正常的栈“警戒线”，否则G会无限次地触发morestack。
			gp.stackguard0 = gp.stack.lo + stackGuard
			// 回到原来的执行点，这次暂时不执行抢占逻辑
			gogo(&gp.sched)
		}

		...
		// 如果需要缩容
		if gp.preemptShrink {
			gp.preemptShrink = false
			shrinkstack(gp)
		}

		if gp.preemptStop {
			preemptPark(gp)
		}

		// 正常的抢占，让出当前的 m
		gopreempt_m(gp)
	}
	
	// ... (省略栈增长的逻辑)
}
```
在这里，我们的 `stackguard0` 可能会是系统监控检测到这个 g 已经运行很久了所以去设置的，也可能是垃圾回收需要 STW 时设置的抢占，总之这里会进行一定的抢占逻辑，如果不满足安全点的条件，那么这次会暂时不执行抢占，这里的 `preemptStop` 代表的是 GC 步骤中，`markroot` 这个函数需要扫描 goroutine 的栈空间所以必须要暂停这个 g 的执行，于是会调用 `suspendG`，扫描完成之后，会通过 `resumeG` 来恢复，所以他其实和我们想要探究的调度没有太大关系，只是 GC 中的一个步骤。

正常的 `gopreempt_m` 底层和 `Goshed` 调用的方法一样，都是让出当前的 m，而当前正在执行的 g 则会放入全局队列。

### 抢占式调度

当然上面提到的抢占依旧是有局限性的，它依赖于函数调用会触发 `morestack` 才能够进行抢占检查。如果我们有一个 g 陷入了 `for` 循环空转，在 1.14 版本之前是无法被抢占或者让出 m 的，在 1.14 之后，引入了一个真正的抢占式调度。它不再依赖于 `stackguard0` 的状态位，而是基于信号中断处理的机制来实现的真正的抢占式调度。当然，了解真正的抢占式调度之前，我们需要补充一下信号是什么。这是 Go 实现异步抢占的关键知识。

我们这里所说的信号其实进程或线程之间进行异步通信的机制，常见的比如 `Ctrl+C` 退出进程就是我们所说的信号，他们都会跳转到内核指定的执行程序来实现处理。

而我们的 Go 程序巧妙地使用了操作系统提供的信号机制来实现了异步的抢占式调度，Go 程序启动时，它会向内核注册一个自定义的信号处理器，也就是 `sighandler`，表示只要收到某个指定的信号，都会去执行这个处理器的代码。以我以前学过的 xv6 为例子，当任何一个操作系统线程因为时间片中断，系统调用或者页中断陷入内核，完成了一系列处理任务之后，准备返回用户空间之前，会检查当前线程是否存在待处理的信号，如果检查到我们 `SIGURG` 这个待处理信号，那么在返回用户空间时并不会返回到原本的执行点，而是程序启动时预先设置的 `sighandler` 从而实现了基于信号的抢占逻辑，而这个抢占信号通常是由**系统监控**发出的，我们的系统监控会遍历每个 p，判断这个 g 是否运行太久了，如果是，那么就会对这个 p 上的 m 发出抢占信号。

回到代码层面，当我们想要抢占当前的 m 的时候，我们会向这个 m 发出 `sigPreempt` 信号，会在**系统监控**中检测这个 g 是否运行了过长时间来决定是否抢占的，而我们可以在 `src/runtime/signal_unix.go` 找到这个函数 `sighandler` 他会检查信号的类型，如果是 `sigPreempt` 信号，那么他最终也会进入到 `preemptPark` 或者 `gopreempt_m` 来取消执行当前的 g，然后进入到 `schedule` 调度新的 g。值得注意的是，虽然我们的协作式抢占和信号抢占在系统监控中重复执行了，但是他俩并不会重复执行，这是因为他们的处理程序在执行调度之前都会进行一定的状态检查，从而防止了重复调度。

### 小结

Go 触发调度的方式总的来说有三种：主动让出，协作式抢占和基于信号的抢占调度。

而协作式抢占和基于信号的抢占在 `sysmon` 中我们可以看出他是双管齐下同时触发的，尽管我们的信号处理依赖了不可避免的中断机制，但是从内核返回的用户空间的变化明显违反了局部性原理，引起了更大的开销。为了减小这个开销，Go 语言的设计者完全可以设置两个不同的超时阈值来防止每次抢占都会触发信号抢占，但是事实上 Go 语言选择了同时执行，我们可以看出 Go 语言比起性能更加注重简洁和公平性。尽管是同时触发，但是也不意味着他会触发两次调度，最终会有一个状态检查来决定这次是否应该触发调度从而防止重复地调度。

## 调度循环

前面提过了我们会触发调度的时机，通过抢占式调度尽量做到了调度的公平性，那么现在我们可以进入到 `schedule` 来看看调度循环到底要干些什么。
```go
// 寻找可以用的 g 进行运行调度。
func schedule() {
	...
top: // 这是无限循环的起点
	...
	// 核心是通过 findRunnable 去寻找一个可以执行的 g
	gp, inheritTime, tryWakeP := findRunnable()

	...

	// 开始执行这个 g
	execute(gp, inheritTime)
}
```
我们可以直接进入到 `findRunnable` 来看看它会怎么找到一个待执行的 g。
```go
// 寻找一个可运行的goroutine来执行。
// 它会尝试从其他P窃取，从本地或全局队列获取g，轮询网络。
func findRunnable() (gp *g, inheritTime, tryWakeP bool) {
	mp := getg().m // 获取当前的M
	
top: // 循环起点
	pp := mp.p.ptr()
	// 看看垃圾回收的 stw 有没有等待。
	if sched.gcwaiting.Load() {
		gcstopm()
		goto top
	}
	...
	// 检查并调度 GC worker goroutine
	if gcBlackenEnabled != 0 {
		if gp, _ := gcController.findRunnableGCWorker(pp, now); gp != nil {
			return gp, false, true // tryWakeP = true 建议唤醒一个新 p。
		}
	}
	// 检查常规任务队列
	// 每 61 次调度循环就检查一次全局队列，防止饿死。
	if pp.schedtick%61 == 0 && !sched.runq.empty() {
		if gp := globrunqget(); gp != nil {
			return gp, false, false
		}
	}

	// 检查自己的本地队列，当然这里会先用 runnext
	if gp, inheritTime := runqget(pp); gp != nil {
		return gp, inheritTime, false // 找到了！返回。
	}
	
	// 全局队列，这里会批量拿一些 g 塞到自己的本地队列，防止每次都拿。
	if !sched.runq.empty() {
		lock(&sched.lock)
		gp, q := globrunqgetbatch(int32(len(pp.runq)) / 2)
		unlock(&sched.lock)
		if gp != nil {
			if runqputbatch(pp, &q); !q.empty() {
				throw("Couldn't put Gs into empty local runq")
			}
			return gp, false, false
		}
	}
	
	// 网络轮询器，主要是帮 net/http 的多路复用干活。
	if netpollinited() && netpollAnyWaiters() && sched.lastpoll.Load() != 0 && sched.pollingNet.Swap(1) == 0 {
		list, delta := netpoll(0)
		sched.pollingNet.Store(0)
		if !list.empty() { // 非阻塞
			gp := list.pop()
			injectglist(&list)
			netpollAdjustWaiters(delta)
			trace := traceAcquire()
			casgstatus(gp, _Gwaiting, _Grunnable)
			if trace.ok() {
				trace.GoUnpark(gp, 0)
				traceRelease(trace)
			}
			return gp, false, false
		}
	}
	
	// 工作窃取
	if mp.spinning || 2*sched.nmspinning.Load() < gomaxprocs-sched.npidle.Load() {
		...
		gp, inheritTime, tnow, w, newWork := stealWork(now)
		if gp != nil {
			// 窃取到了
			return gp, inheritTime, false
		}
		...
	}

		// 帮 gcMarkWorker 干活
	if gcBlackenEnabled != 0 && gcMarkWorkAvailable(pp) && gcController.addIdleMarkWorker() {
		node := (*gcBgMarkWorkerNode)(gcBgMarkWorkerPool.pop())
		if node != nil {
			...
			gp := node.gp.ptr()
			...
			return gp, false, false
		}
		...
	}
	
	...

	// 最后再检查一遍
	if !sched.runq.empty() {
		// 发现全局队列又有 g 了
		unlock(&sched.lock)
		return gp, false, false
	}
	
	// 放弃 p
	if releasep() != pp { throw("...") } // M与P解绑
	pidleput(pp, now) // 将P放入全局空闲列表
	unlock(&sched.lock)

	// 此时 m 失去了 p，它可以干的就是阻塞地检查网络轮询器，负责多路复用和计时器的监听
	if netpollinited() && (netpollAnyWaiters() || pollUntil != 0) && sched.lastpoll.Swap(0) != 0 {
		...
		list, delta := netpoll(delay)
		...
		if faketime != 0 && list.empty() {
			// 还没有就睡了
			stopm()
			goto top
		}
		// 否则取一个 p 来执行
		lock(&sched.lock)
		pp, _ := pidleget(now)
		unlock(&sched.lock)
		if pp == nil {
			// 如果没有找到 p 可以执行，可以注入到别人的队列里面去执行这些 g
		} else {
			acquirep(pp)
			if !list.empty() {
				...
				return gp, false, false
			}
			goto top
		}
	}
	...
	
	// 如果连网络轮询都不需要做，就调用 stopm()，让M彻底进入休眠。
	// 它会一直睡，直到被 wakep() 明确地唤醒。
	stopm()
	goto top // 重新开始找
}
```
虽然 `findRunnable` 函数实现非常复杂，但是它的目的只有一个，那就是找到一个可以执行的 g，他的先后顺序是：
1. gcWorker，垃圾回收阶段，如果当前标记进度严重落后，那么就会去执行一个专门的 gcWorker。
2. 每 61 次调度会先去全局队列中找 g 执行保证公平性
3. 本地队列。
4. 全局队列。
5. 非阻塞的网络轮询。
6. 窃取其他 p 的本地队列。
7. 尽力去处理 gcWorker。

最后再检查一遍全局队列里面有没有可以执行的 g，如果没有，那么这个 M 就会调用 `releasep` 和当前的 p 解绑并将它放入空闲 p 列表，而我们的 m 则用来阻塞地调用网络轮询，等待多路复用事件的到来或者计时器事件的到来。当然，我们的 `findRunnable` 肯定不是单纯的线性执行，中间存在着不少 goto 语句，这也意味着并不是说执行了某个阶段之后一定会执行下一个阶段，有可能会跳转到第一个阶段从头开始，这就是它叫做调度循环的原因。

虽然这个一步一步去找的步骤很无聊，但是也能看见一些有趣的优化，比如从全局队列拿 g 的时候是批量抓取而不是一个一个地获取，减少了锁竞争，当然，从其他 p 的本地队列窃取 g 也是批量窃取 g 塞入自己的队列中。当然除了这些以外，`findRunnableGCWorker` 本身也是一个有趣的实现，它做的不仅仅是从 gcWorker 里面取出一个 g 执行，他会衡量当前的 GC 任务是否紧张，根据实际需要决定是否应该在这个时候调度 gcWorker。

## 一些有趣的细节

### 系统调用

我们经常会说在陷入阻塞系统调用的时候，这个 m 会和 p 立即解绑，会去另外找一个 m 去执行，而非阻塞的系统调用虽然也会解绑，但是这个 m 会记住这个 p，等从系统调用返回之后，会优先去获取这个 p，刘丹冰的《深入理解Go语言》也正是这么写的，但是这个说法（阻塞和非阻塞）并不算准确：
```go
func reentersyscall(pc, sp, bp uintptr) {
	...

	// g 状态改变
	casgstatus(gp, _Grunning, _Gsyscall)

	...
	
	// 记录下当前P的调度tick，sysmon会用它来判断syscall是否超时。
	gp.m.syscalltick = gp.m.p.ptr().syscalltick

	// 解绑逻辑
	pp := gp.m.p.ptr() // 获取当前M绑定的P
	pp.m = 0
	gp.m.oldp.set(pp) // 记住它，回来时优先找他
	gp.m.p = 0 
	
	atomic.Store(&pp.status, _Psyscall)
	...
}

```
我们可以看见，这里仅仅只有解绑逻辑，并没有任何关于阻塞或者非阻塞的判断，然而在任何 syscall 的包里面都只有 `reentersyscall` 的调用，所以并不存在明显的阻塞系统调用或者非阻塞的系统调用的界限，而 `reentersyscall` 的作用也只是将 m 和 p 解绑，并不存在任何判断阻塞或者非阻塞的逻辑。而我们说的阻塞和非阻塞的逻辑判断以及是否让出挂起 m，其实是在系统监控中做的。

在 `retake` 中，我们检查状态位 `_Psyscall` 的 p 是否已经陷入很久了，并决定去是否应该为他设置新的 m。
```go
if s == _Psyscall {
	// 如果P在syscall状态超过1个sysmon tick（至少20µs），就收回它。
	t := int64(pp.syscalltick) // 读取P进入syscall时的tick计数。

	// pd 是 sysmon 自己维护的，记录了它上次巡逻时，每个P的状态。
	if !sysretake && int64(pd.syscalltick) != t {
		// 这是sysmon第一次发现这个P进入了syscall状态（tick值变了）。
		pd.syscalltick = uint32(t)
		pd.syscallwhen = now
		
		// 只是记录，不采取行动，再给它一次机会。
		// 也许这个syscall很快就返回了。
		continue 
	}

	// 一个优化
	if runqempty(pp) && // 条件1: 这个P自己的本地队列是空的，
	   sched.nmspinning.Load()+sched.npidle.Load() > 0 && // 条件2: 并且系统里有其他空闲/自旋的资源，说明不缺P，
	   pd.syscallwhen+10*1000*1000 > now { // 条件3: 并且卡住的时间还不到10毫秒。
		
		// 如果同时满足这三个条件，意味着：
		// 1. “抢救”回这个P，也没活给它干。
		// 2. 整个系统不忙，不急需这个P。
		// 3. 卡住的时间还不算太长。
		//
		// 结论：再等等看，现在“抢救”的性价比不高。
		continue
	}

	// 如果代码走到了这里，说明“抢救”是必要的。
	// 要么是P上有任务，要么是系统很忙，要么是P卡得太久了。
	...
	if atomic.Cas(&pp.status, s, _Pidle) {
		if trace.ok() { trace.ProcSteal(pp, false) }
		
		pp.syscalltick++
		
		// handoffp会检查这个P是否有工作，
		// 如果有，就为它找一个M；如果没有，就把它放入空闲列表。
		handoffp(pp)
	}
	...
}
```
虽然对于阻塞和非阻塞并没有明确的规定，但是我觉得这里的说法还是可以再优化一下，阻塞还是非阻塞，要不要给这个 P 安排新的 M 完全取决于系统监控以及当时的资源紧张情况。

当然，在退出执行系统调用的时候，会执行 `exitsyscall` 这个函数，此时会优先去获取原来的 p，即陷入系统调用之前记录的 `oldp`，如果这个 p 已经转而去执行其他 m 了，那么就会从空闲的 p 中找一个来执行这个 m，如果没有任何能够执行这个 m 的 p，那么就会将这个 g 放入全局的运行队列，而这个 m 则通过 `stopm` 进入到空闲的 m 列表，并陷入睡眠。

还有一个值得说的是，cgo 调用也会经过 `reentersyscall`，换而言之，系统监控把 cgo 调用也当作系统调用处理。

另外，很多人会认为 `entersyscallblock` 会在调用会引发阻塞的系统调用时调用，实际上并不是这样，前面也说了，`syscall` 包里面只会在进入系统调用之前调用 `reentersyscall`，那么 `entersyscallblock` 到底是干什么的？我们可以注意到调用这个 `entersyscallblock` 的 `notetsleepg` 主要是由 `signal_recv` 调用，然后通过 linkname 链接到了 `os/signal` 包，目前来看主要是用于一个信号通知的机制，也就是我们所说的 `Notify` 会用到他，但是这里我也没咋（懒得）研究，有兴趣的可以自己看看吧。

### 线程 M

之前在小红书上看见一个面经，问 m 什么时候会销毁，我确实不知道这个玩意，在看源码的时候也没有找到确切的答案什么时候会销毁 m，到处搜文章，找到了一篇 [go对M和线程的管理](https://zhuanlan.zhihu.com/p/1908657908163511866) 感觉总结的还不错。

上面我们提到了 `handoffp` 会为有 g 的 p 找一个 m 执行命令，如果找不到就会创建一个新的 m，其中涉及到的系统调用就是 `clone`，`clone` 这个系统调用会新建一个内核线程，从 `mstart` 开始执行，最后进入到 `schedule` 永不返回。这里有个问题就是，如果 m 进入到了 schedule，那么它到底该怎么退出呢？在运行过程中，正常情况下，Go 的 m 线程只会增长，当空闲时会进入到空闲 m 列表，忙碌时会先从空闲 m 列表中获取 m 来执行，如果没有 m 那么就会再创建一个新的 m 参与调度，这也意味着在某个时刻如果有突发的流量进入系统，就可能会导致在这个时候创建很多 m，从而导致系统中出现大量的 m 而无法销毁，所以我们在编写业务代码的时候需要限制任务数量，或许协程池是一个有效的手段。

那么有没有不正常的情况呢？是有的，通过 `runtime.LockOSThread()` 锁定到线程的 goroutine 退出时，Go 就会终止这个线程，具体的链路可以参考我上面贴的文章或者在 `Goexit` 中找到。


## 总结

Go 的调度器还是比较复杂的，涉及到方方面面，其实在这里还想介绍一下网络轮询器的源码，但是我已经找到一个无法超越的文章了（放下面的），写得特别好，在本文的最后贴一下几篇让我受益匪浅的文章吧。

[揭秘 Go 网络轮询器：从 Epoll 到 Netpoll 的架构实现](https://kydenul.github.io/posts/golang-netpoll/)

[go对M和线程的管理](https://zhuanlan.zhihu.com/p/1908657908163511866)

[Go 语言设计与实现之调度器](https://draven.co/golang/docs/part3-runtime/ch06-concurrency/golang-goroutine/)

[Go 运行时之程序的启动](https://chenbc.xlog.app/go-bootstrap)
