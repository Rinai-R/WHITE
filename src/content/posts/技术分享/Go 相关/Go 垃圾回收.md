---
title: Go 的 GC 链路梳理
published: 2025-12-04
description: 众所周知，我们现版本的 Go 默认是使用的三色标记法，八股文已经听腻了，来看点源码理解一下 GC 流程。
image: ./assets/2025-12-04.png
tags:
  - Golang
  - 垃圾回收
category: 技术分享
draft: false
---


众所周知，我们现版本的 Go 默认是使用的三色标记法，八股文已经听腻了，来看点源码理解一下 GC 流程。

## 何时会触发垃圾回收？

### 系统监控

懂行的都知道，gc 的入口是 [gcStart](https://github.com/golang/go/blob/2b62144069a130cc469f33009c0c392cc6de8810/src/runtime/mgc.go#L733)，所以我们只需要顺着他的调用链路向上找，可以知道会有一个后台协程 [forcegchelper](https://github.com/golang/go/blob/2b62144069a130cc469f33009c0c392cc6de8810/src/runtime/proc.go#L365) 会重复检测是否满足 GC 的状态：
```go
// init 函数在包初始化时运行，启动一个强制 GC 的辅助 goroutine
func init() {
	go forcegchelper()  // 启动一个独立 goroutine，专门负责触发强制 GC
}

// forcegchelper 是强制 GC 的后台辅助 goroutine
func forcegchelper() {
	forcegc.g = getg()

	lockInit(&forcegc.lock, lockRankForcegc)

	for {
		lock(&forcegc.lock)

		if forcegc.idle.Load() {
			throw("forcegc: phase error")
		}

		forcegc.idle.Store(true)

		// 将当前 goroutine 挂起，释放锁，等待 sysmon（系统监控 goroutine）唤醒
		goparkunlock(&forcegc.lock, waitReasonForceGCIdle, traceBlockSystemGoroutine, 1)

		if debug.gctrace > 0 {
			println("GC forced")
		}

		gcStart(gcTrigger{kind: gcTriggerTime, now: nanotime()})
	}
}
```
虽然是使用的 for 循环不断检测是否满足 gc 条件，但是这里有一个 gopark，稍微有了解 go 源码的都知道， gopark 意味着将这个协程挂起，也就是将 M 线程资源让出来，从而避免长时间阻塞在这里等待满足 gc 条件。那么什么时候会唤醒这个 goroutine 呢？答案写在注释里面，当系统监控觉得确实应该触发 GC 了，就会唤醒这个后台强制 GC 的 goroutine。

他是如何被唤醒的？可以在 [sysmon()](https://github.com/golang/go/blob/41d8e61a6b9d8f9db912626eb2bbc535e929fefc/src/runtime/proc.go#L5026) 的末尾找到答案，通过 [gcTrigger](https://github.com/golang/go/blob/41d8e61a6b9d8f9db912626eb2bbc535e929fefc/src/runtime/mgc.go#L1234) 去判断是否应该触发强制 GC，如果应该 gc 了，那么就会将这个 goroutine 唤醒，其实就是将他放回调度队列里面：
```go
		if t := (gcTrigger{kind: gcTriggerTime, now: now}); t.test() && atomic.Load(&forcegc.idle) != 0 {
			lock(&forcegc.lock)
			forcegc.idle = 0
			var list gList
			// 放回队列
			list.push(forcegc.g)
			injectglist(&list)
			unlock(&forcegc.lock)
		}
```


### 申请内存

还有 [newUserArenaChunk](https://github.com/golang/go/blob/2b62144069a130cc469f33009c0c392cc6de8810/src/runtime/arena.go#L739) ，什么时候会触发这个所谓的 newUserArenaChunk 呢？简单来说就是堆内存需要新申请的时候，此时就会去检测是否应该触发 GC，除此之外，检测是否应该触发 GC 的地方 [mallocgc](https://github.com/golang/go/blob/2b62144069a130cc469f33009c0c392cc6de8810/src/runtime/malloc.go#L1119) ，这是一个通用的分配内存的函数，总之，当我们申请内存的时候，我们都会去检查是否应该去触发 GC，就这么简单；除此之外说一句题外话，我们可以在这些 malloc 函数中看见读写屏障的具体逻辑，当开启了写屏障时，此时就会帮助直接标记为灰色。

## gcStart 干了啥？

### 大体流程

剔除一些无关紧要的代码，如下所示：
```go
// gcStart 启动 Go 垃圾回收（GC）。
//
// trigger: 指示 GC 启动条件的触发器，例如堆大小超过阈值或手动触发。
//
// 注意：
// - 如果当前在系统栈上或持有锁，不会启动 GC。
// - 根据 debug.gcstoptheworld 的设置，可能执行并发 GC 或 Stop-The-World GC。
func gcStart(trigger gcTrigger) {
	...

    // 启动后台 mark 工作 goroutine
    // 就是这里面做的标记工作
    gcBgMarkStartWorkers()

    // 初始化 STW（Stop-The-World）相关信息
    work.stwprocs, work.maxprocs = gomaxprocs, gomaxprocs
    if work.stwprocs > numCPUStartup {
        work.stwprocs = numCPUStartup
    }
    work.heap0 = gcController.heapLive.Load()
    work.pauseNS = 0
    work.mode = mode

    now := nanotime()
    work.tSweepTerm = now

    // 系统栈执行 STW
    var stw worldStop
    systemstack(func() {
        stw = stopTheWorldWithSema(stwGCSweepTerm)
    })

    // 累计暂停时间
    work.cpuStats.accumulateGCPauseTime(stw.stoppingCPUTime, 1)

    // 在系统栈完成 sweep
    systemstack(func() {
        finishsweep_m()
    })

    // 清理对象池
    clearpools()

    // GC 周期计数加一
    work.cycles.Add(1)

    // 启用协助机制和工作线程
    gcController.startCycle(now, int(gomaxprocs), trigger)
    gcCPULimiter.startGCTransition(true, now)

    if mode != gcBackgroundMode {
        schedEnableUser(false) // STW 模式下禁止用户 goroutine 调度
    }

    // 进入并发 mark 阶段，并启用写屏障
    setGCPhase(_GCmark)
    gcBgMarkPrepare()
    // 这个函数挺重要的，会把所有的待扫描的对象空间分成多个 task。
    gcPrepareMarkRoots()
    gcMarkTinyAllocs()
    atomic.Store(&gcBlackenEnabled, 1)

    mp = acquirem()

    // 更新 CPU 统计信息
    work.cpuStats.accumulateGCPauseTime(nanotime()-stw.finishedStopping, work.maxprocs)

    // 并发 mark 开始，STW 停止
    systemstack(func() {
        now = startTheWorldWithSema(0, stw)
        work.pauseNS += now - stw.startedStopping
        work.tMark = now

        gcCPULimiter.finishGCTransition(now)
    })

	...
}
```

其中最值得注意的函数就是 `gcBgMarkStartWorkers` 和 `gcPrepareMarkRoots` 这两个函数在我们之后的分析里面算是最重要的。

首先我们看看 `gcBgMarkStartWorkers` 干了什么，一串下去的链路是
> gcBgMarkStartWorkers -> gcBgMarkWorker -> gcDrainMarkWorkerIdle -> gcDrain

而这个 `gcDrain` 函数就是最后我们需要分析的地方，这里很复杂。

`gcDrain` 会扫描 root 对象，不断将灰色对象标记为黑色，直到没有更多任务可以标记，`gcDrain` 并不是在一个专门的 M 上执行，所以我们需要考虑到其他业务任务的执行，如果长期执行 `gcDrain` 就会导致负责业务的 goroutine 饿死，所以 `gcDrain` 也提供了一些抢占点检查是否应该让出 M。

首先我们需要知道，这个抢占点的检查是什么：
```go
checkWork := int64(1<<63 - 1)
var check func() bool
if flags&(gcDrainIdle|gcDrainFractional) != 0 {
    checkWork = initScanWork + drainCheckThreshold
    if idle {
        check = pollWork
    } else if flags&gcDrainFractional != 0 {
        check = pollFractionalWorkerExit
    }
}
```
这个 pollWork 是什么？其实就是看当前程序中是否有网络 IO 就绪非阻塞调用一下 netpoll，查看是否有事件已经准备好了，防止 gc 阻塞了重要任务的执行。

第二个 pollFractionalWorkerExit 则是一个检测自己有没有执行过长时间，如果执行时间太长了，那么就会让出当前的 M 线程，让其他 goroutine 执行；在后续，我们每次循环标记的过程中都会去调用这个 check() 来防止任务被 GC 任务阻塞了，因为相对来说，GC 后台标记这个任务优先级是比较低的。

下面是第一个标记循环，目的很清晰，就是从之前提到的 `gcPrepareMarkRoots` 中的 Tasks 中通过原子操作去获取一个 Task 来标记，同时，在每次任务标记完之后，就会检查一遍是否应该让出 M 线程。这里的原子操作保证了 go 中的 GC 可以并发安全的进行标记，而 markroot 就是对所有的 root 对象进行扫描标记，root 是可达活对象的起点，包括但不限于全局变量，栈。
```go
for !(gp.preempt && (preemptible || sched.gcwaiting.Load() || pp.runSafePointFn != 0)) {
    job := atomic.Xadd(&work.markrootNext, +1) - 1
    if job >= work.markrootJobs {
        break
    }
    markroot(gcw, job, flushBgCredit)
	if check != nil && check() {
		goto done
	}
    ...
}
```
想要知道 root 包含那些内存数据，我们可以在之前提过的 `gcPrepareMarkRoots` 里面找到：
```go
// gcPrepareMarkRoots 准备 GC 根对象扫描任务
func gcPrepareMarkRoots() {
    // 确认此时世界已停止（STW），防止在扫描过程中有 goroutine 修改 root
    assertWorldStopped()

    // 用于计算需要多少个 root block（数据块）来存储给定字节数的 root
    nBlocks := func(bytes uintptr) int {
        return int(divRoundUp(bytes, rootBlockBytes))
    }

    // 初始化 data 和 BSS root 的数量
    work.nDataRoots = 0
    work.nBSSRoots = 0

    // 扫描全局变量段（data / BSS 段）
    for _, datap := range activeModules() {
        nDataRoots := nBlocks(datap.edata - datap.data) // data 段需要多少 root block
        if nDataRoots > work.nDataRoots {
            work.nDataRoots = nDataRoots
        }

        nBSSRoots := nBlocks(datap.ebss - datap.bss) // BSS 段需要多少 root block
        if nBSSRoots > work.nBSSRoots {
            work.nBSSRoots = nBSSRoots
        }
    }

    // 扫描 span roots（用于 finalizer 特殊对象）
    // GC 会扫描在 mark 阶段开始时可用的 heapArenas（即 markArenas）
    mheap_.markArenas = mheap_.heapArenas[:len(mheap_.heapArenas):len(mheap_.heapArenas)]
    work.nSpanRoots = len(mheap_.markArenas) * (pagesPerArena / pagesPerSpanRoot)

    // 扫描 goroutine 栈
    // 注意，之后新创建的 goroutine 不会被扫描，但它们的 root 会被写屏障捕获
    work.stackRoots = allGsSnapshot()
    work.nStackRoots = len(work.stackRoots)

    // 初始化 root 扫描任务索引
    work.markrootNext = 0
    // 总共需要扫描的 root 数量
    work.markrootJobs = uint32(fixedRootCount + work.nDataRoots + work.nBSSRoots + work.nSpanRoots + work.nStackRoots)

    // 计算每类 root 的起始索引，用于 markroot 调度
    work.baseData = uint32(fixedRootCount)                      // data root 起始索引
    work.baseBSS = work.baseData + uint32(work.nDataRoots)     // BSS root 起始索引
    work.baseSpans = work.baseBSS + uint32(work.nBSSRoots)     // span root 起始索引
    work.baseStacks = work.baseSpans + uint32(work.nSpanRoots) // stack root 起始索引
    work.baseEnd = work.baseStacks + uint32(work.nStackRoots)  // 所有 root 的结束索引
}

```
这里其实就是做了一些计算工作，将当前的程序中的一些内存数据保存下来，并分块成多个 task，方便之后并发的进行标记处理，我们不需要太过于在意这些数据是怎么得出来的，只需要知道是这么回事即可。

那么我们标记 root 之后，我们便需要去标记 heap 对象了，此时我们当然需要依赖之前从 root 中标记的对象去标记 heap 内存中的对象：

```go
// 这是 GC 的 heap 标记循环，用于从灰色对象队列中继续标记对象，直到队列为空或需要暂停。
// 此循环在 GC 的标记阶段执行（_GCmark）。
//
// 循环条件：如果当前 G 被标记为可抢占，并且满足以下任意条件则停止循环：
// - preemptible 为 true
// - sched.gcwaiting 表示有人想触发 STW（Stop The World）
// - pp.runSafePointFn != 0 表示有 P 正在执行安全点函数
for !(gp.preempt && (preemptible || sched.gcwaiting.Load() || pp.runSafePointFn != 0)) {

    // 尝试保证全局队列中有可用工作。
    // 如果 work.full == 0，说明本地队列空了，需要从全局队列平衡一些工作。
    if work.full == 0 {
        gcw.balance()
    }

    // 从工作队列中获取下一个待扫描对象或 span
    var b uintptr  // 单个对象指针
    var s objptr   // span 指针

    // 尝试按优先级获取灰色对象
    if b = gcw.tryGetObjFast(); b == 0 {          // 优先尝试快速队列
        if s = gcw.tryGetSpan(false); s == 0 {   // 没有对象，尝试获取 span
            if b = gcw.tryGetObj(); b == 0 {     // 再尝试普通队列
                wbBufFlush()                     // 写屏障缓冲区 flush，可能产生新的灰色对象
                if b = gcw.tryGetObj(); b == 0 { // 再次尝试获取对象
                    s = gcw.tryGetSpan(true)     // 最后尝试获取 span
                }
            }
        }
    }

    // 如果拿到对象或 span，就扫描它们
    if b != 0 {
        scanobject(b, gcw)  // 扫描对象，将其引用的对象加入灰色队列
    } else if s != 0 {
        scanSpan(s, gcw)    // 扫描 span，处理里面的对象
    } else {
        // 队列空，无法获取更多工作，循环结束
        break
    }

    // 如果实验性 GreenTea GC 需要新 worker，则启动
    if goexperiment.GreenTeaGC && gcw.mayNeedWorker {
        gcw.mayNeedWorker = false
        if gcphase == _GCmark {
            gcController.enlistWorker()
        }
    }

    // 将本地累积的扫描工作量计入全局，供 mutator assist 使用
    if gcw.heapScanWork >= gcCreditSlack {
        gcController.heapScanWork.Add(gcw.heapScanWork) // 增加全局 heapScanWork
        if flushBgCredit {
            gcFlushBgCredit(gcw.heapScanWork - initScanWork) // flush 背景扫描信用
            initScanWork = 0
        }
        checkWork -= gcw.heapScanWork
        gcw.heapScanWork = 0

        // 检查，之前提到的 check
        if checkWork <= 0 {
            checkWork += drainCheckThreshold
            if check != nil && check() {
                break
            }
        }
    }
}
```

到这里其实已经把 GC 的逻辑梳理的差不多了，其他诸如 STW，StartTheWorld 都没有讲述。但是其实我们还可以更细粒度的去看看 `tryget` 还有 `markroot` 都干了些什么，这里有点不太想贴源码，就直接口述了。

### 迭代标记

markroot的函数签名是 `markroot(gcw *gcWork, i uint32, flushBgCredit bool) int64`，这个 i 就是所谓的 taskId，我们可以根据这个 id 找到当前需要进行扫描标记的区域，大多数都是调用 `scanblock` 去扫描的，而在这个函数中，经历一系列复杂的变换和扫描，由于我不懂 GC 的扫描逻辑，所以就不乱讲，最终我们会把扫描到的可达对象通过 `greyobject` 将这个对象标记为**灰色**，如果对象不可扫描，则标记为黑色，在将他标记为灰色之后，我们还会将他通过 `gcw.putObj` 放入到本地的标记处理队列里面，这一步的意义其实就是迭代处理，在第二阶段标记的时候，我们也是最终会调用 `greyobject` 将这个函数染灰，并推送到本地标记处理队列里面，用于迭代处理，思想上有点类似广度优先搜索。

```go
// greyobject 将一个堆对象标记为灰色（可扫描），并将其加入到 P 的本地工作队列 gcw 中，以便后续扫描其内部指针。
// 如果对象不可扫描（noscan），则直接标记为黑色。
//
// 参数说明：
// obj       : 要标记的对象起始地址
// base, off : 调试信息，用于记录对象是通过哪个 root 扫描到的
// span      : 对象所在的内存 span
// gcw       : 当前 P 的本地 GC 工作队列
// objIndex  : 对象在 span 中的索引
//
// go:nowritebarrierrec 表示此函数不会触发写屏障，且可递归调用
func greyobject(obj, base, off uintptr, span *mspan, gcw *gcWork, objIndex uintptr) {
	...

	// 将对象加入 P 的本地工作队列，以便后续 scanobject 扫描其指针
	if !gcw.putObjFast(obj) { // 快速入队
		gcw.putObj(obj)       // 慢速入队（如果快速失败）
	}
}

```

你可能会注意到，第二阶段的扫描只调用了 `scanobject` ，实际上，它内部也是调用的 `greyobject`，他会将这个对象引用的指针通过 `greyobject` 变为灰色，并放入本地工作队列，以便于下一次的迭代。

```go
// scanobject 扫描以 b 开头的堆对象，将对象内部的指针加入 gcw 队列。
// b 必须指向一个堆对象或 oblet（大对象的分块）。
// scanobject 会根据 GC 的位图获取指针掩码，并通过 span 获取对象大小。
//
//go:nowritebarrier 表示该函数不会触发写屏障。
func scanobject(b uintptr, gcw *gcWork) {
	...
	var scanSize uintptr
	for {
		var addr uintptr
		// 尝试快速获取下一个指针
		if tp, addr = tp.nextFast(); addr == 0 {
			// 如果没有快速指针，再走慢路径
			if tp, addr = tp.next(b + n); addr == 0 {
				break
			}
		}

		// 更新扫描范围，用于统计 heapScanWork
		scanSize = addr - b + goarch.PtrSize

		// 读取对象中的潜在指针
		obj := *(*uintptr)(unsafe.Pointer(addr))

		// 过滤掉 nil 和指向当前对象内部的指针
		if obj != 0 && obj-b >= n {
			// 判断 obj 是否指向 Go 堆中的对象，如果是则标记
			// 注意可能存在与分配同时发生的竞争，findObject 可能失败
			if !tryDeferToSpanScan(obj, gcw) {
				if obj, span, objIndex := findObject(obj, b, addr-b); obj != 0 {
					// 将指针对象标记为灰色，并入队等待扫描
					greyobject(obj, b, addr-b, span, gcw, objIndex)
				}
			}
		}
	}

	// 更新本地 GC 工作队列的统计信息
	gcw.bytesMarked += uint64(n)
	gcw.heapScanWork += int64(scanSize)
	if debug.gctrace > 1 {
		gcw.stats[s.spanclass.sizeclass()].sparseObjsScanned++
	}
}

```

综上所述，三色标记的大致的流程如下：
```
markroot（扫描 root 对象：全局变量、栈、span specials）
    ↓
发现堆对象 → greyobject → 标灰 + 入本地队列 gcw
    ↓
heap 扫描阶段（drain heap marking jobs）
    ↓
从 gcw 队列取灰对象（tryGetObj/tryGetSpan）
    ↓
scanobject 扫描对象内部指针
    ↓
扫描出的新对象 → greyobject → 入 gcw 队列（迭代处理）
    ↓
重复直到队列为空 → 所有可达对象都被标记
```

这下我们知道了，网上图解的三色标记法其实就是一个在三色的基础上进行广度优先搜索，图还是很生动形象的，然而，有的东西也需要真正去看这部分逻辑才能学到，GC 不仅仅就是个垃圾回收，他的运行过程还和系统监控，网络轮询器有着一定的关系，感觉看源码有助于对整个 runtime 的认知，虽然我把 STW，读写屏障还有三色标记的具体算法没有重点讲解，但是本篇文章主要注重逻辑梳理。

## 一些优化

除了上面所说的标记以外，我们的 `mallocgc` 其实也会在 gc 阶段帮助我们进行部分标记工作，这就是我们常说的 Mutator Assist 优化
```go
// mallocgc 分配一个指定大小的对象。
// 小对象从 P（处理器本地）缓存的 free list 分配。
// 大对象（> 32 KB）直接从堆分配。
// mallocgc 是 runtime 内部接口，但一些第三方库通过 //go:linkname 调用。
// 请勿修改函数签名，否则可能破坏 runtime。
//
// 参数:
//   size     - 需要分配的字节数
//   typ      - 对象类型信息 (_type)，用于 GC 扫描指针；nil 表示 noscan
//   needzero - 是否需要将分配的内存清零
//
// 返回值:
//   unsafe.Pointer - 指向分配好的对象
//
// go:linkname 指令允许其他包直接调用 runtime.mallocgc
//
// mallocgc 核心功能:
// 1. 检查 GC assist，决定 mutator 是否需要帮忙做标记。
// 2. 根据对象大小选择 tiny allocator / small allocator / large allocator。
// 3. 调用 sanitizers（race、msan、asan、valgrind）。
// 4. 调整 GC assist 债务。
func mallocgc(size uintptr, typ *_type, needzero bool) unsafe.Pointer {
	...

	// 当前是否在 GC mark 阶段且 write barrier 启用
	// 如果需要，mutator（分配者）需要帮忙标记一些对象
	if gcBlackenEnabled != 0 {
		deductAssistCredit(size) // 借款，并可能触发 gcDrain
	}

	...
}
```

在这里借款之后，如果发现分配的 size 过大，哪怕是从全局借款中也没办法抵消债务，那么就会触发 gcDrainN，强制执行一部分标记工作，当然，如果还是不够，那么就会直接让这个 goroutine “坐牢”，即不能让他继续被 P 调度，同时放入 AssistQueue，这里的意思就是说，当前 goroutine 借款过多，无法继续调度，需要等待其他的 gcWorker 去执行标记工作，以此来生产借款到全局债务中，此时，我们又可以唤醒这些 AssistQueue 中的 goroutine，也就是让他们能够继续运行。总的来说，其实就是一个生产者消费者的协作模型，当一部分 goroutine 需要申请大量内存，而标记的 worker 速度跟不上的时候，此时就会阻塞这些 goroutine 进行执行，直到 gcworker 的速度跟上申请的速度，此时就会让他们继续执行，借款的链路为 gcAssistAlloc->gcParkAssist：
```go
// gcParkAssist 将当前的 goroutine 放入 assist 队列并将其挂起，
// 直到满足 GC 协助条件。协助标记的任务由多个 goroutine 共同完成。
// 
// 当返回值为 true 时，表示该协助任务已经完成，goroutine 可继续执行。
// 如果返回 false，说明协助任务还未完成，调用者应当重试协助。
//
// 该函数通过加锁、检查 GC 状态、挂起当前 goroutine 来保证协助任务的顺利进行。
// 它帮助实现协作式垃圾回收，避免 GC 阻塞或资源浪费。
func gcParkAssist() bool {
    // 加锁以确保对 assistQueue 的操作是线程安全的
    lock(&work.assistQueue.lock)

    // 如果 GC 循环已经完成，则直接退出协助，返回 true
    // 因为在持有锁时，GC 周期无法结束
    if atomic.Load(&gcBlackenEnabled) == 0 {
        unlock(&work.assistQueue.lock)
        return true
    }

    // 获取当前的 goroutine（gp），并将其加入 assist 队列
    gp := getg()
    oldList := work.assistQueue.q
    work.assistQueue.q.pushBack(gp)

    // 重新检查背景扫描的 credit，以确保当前的挂起 goroutine 不会被漏掉
    // 如果背景标记已生成足够的 credit，则可以让当前 goroutine 继续执行
    if gcController.bgScanCredit.Load() > 0 {
        // 恢复队列状态，取消挂起的 goroutine
        work.assistQueue.q = oldList
        if oldList.tail != 0 {
            oldList.tail.ptr().schedlink.set(nil)
        }
        unlock(&work.assistQueue.lock)
        return false
    }

    // 如果 credit 不够，挂起当前 goroutine
    goparkunlock(&work.assistQueue.lock, waitReasonGCAssistWait, traceBlockGCMarkAssist, 2)
    return true
}
```
而我们的每次 gcWorker 执行了标记工作之后，都会去调用 `gcFlushBgCredit` 尝试去唤醒这些消费者：
```go
// gcFlushBgCredit 将指定数量的后台扫描工作单位（scanWork）信用刷新到后台扫描信用池。
// 它首先会满足阻塞在工作队列中的 goroutine 的协助债务，然后将剩余的信用刷新到
// gcController.bgScanCredit，供其他需要的协助任务使用。
//
// 由于这是由 gcDrain 使用，在执行时确保所有的工作都已完成，所以在该函数中不允许
// 写入屏障。
// 
// 该函数的核心逻辑是分配信用并协助完成挂起的协助任务，保证 GC 协作过程的平衡。
//go:nowritebarrierrec
func gcFlushBgCredit(scanWork int64) {
    // 如果 assist 队列为空，则表示没有待协助的 goroutine，直接将扫描工作信用加到后台信用池
    if work.assistQueue.q.empty() {
        // 快速路径；没有阻塞的协助任务。这里有一个小的窗口，如果有协助任务被加入并挂起，
        // 它会在下一次调用时处理。
        gcController.bgScanCredit.Add(scanWork)
        return
    }

    // 计算每单位扫描工作需要多少字节的协助信用
    assistBytesPerWork := gcController.assistBytesPerWork.Load()
    scanBytes := int64(float64(scanWork) * assistBytesPerWork)

    // 加锁，确保对 assistQueue 操作的线程安全
    lock(&work.assistQueue.lock)

    // 遍历队列中的所有阻塞 goroutine，尝试用当前扫描信用偿还它们的协助债务
    for !work.assistQueue.q.empty() && scanBytes > 0 {
        gp := work.assistQueue.q.pop()

        // 注意，gp.gcAssistBytes 是负数，因为 goroutine 之前积累了协助债务
        // 判断当前扫描信用是否能够满足 goroutine 的债务
        if scanBytes+gp.gcAssistBytes >= 0 {
            // 如果当前的信用足够偿还整个债务，更新扫描字节并清空债务
            scanBytes += gp.gcAssistBytes
            gp.gcAssistBytes = 0

            // 注意：不要将这个 goroutine 放到 runnext 队列中，以避免它的高优先级
            // 被滥用，阻塞其他 goroutine 执行。
            ready(gp, 0, false)
        } else {
            // 如果信用不足以偿还整个债务，只偿还部分债务
            gp.gcAssistBytes += scanBytes
            scanBytes = 0

            // 为了避免大的协助任务堵塞队列，我们将该任务移到队列的末尾，
            // 确保小的协助任务能及时得到处理。
            work.assistQueue.q.pushBack(gp)
            break
        }
    }

    // 如果仍然有剩余的扫描字节（信用不足以偿还所有的协助债务），
    // 我们将它们转回到后台扫描信用池中
    if scanBytes > 0 {
        // 将剩余的扫描字节转换为相应的工作量
        assistWorkPerByte := gcController.assistWorkPerByte.Load()
        scanWork = int64(float64(scanBytes) * assistWorkPerByte)
        gcController.bgScanCredit.Add(scanWork)
    }

    // 解锁，完成当前的工作信用分配
    unlock(&work.assistQueue.lock)
}
```


通过上面的分析，我们可以发现，我们的 GC 是通过广度优先搜索的方式去从堆上扫描对象来进行回收，也就是说，如果堆上的内存小，但是对象多，就会给 GC 带来很大的压力，所以这就是我们需要进行逃逸分析，在一些情况下尽量避免内存逃逸到堆上；除了这些 GC 的步骤之外，还引入了租约的制度来平衡申请内存和标记的速度。

看完这部分源码我觉得《Go 语言设计与实现》讲的是真的不错，但是真的得自己再去看看源码才能把整个链路搞明白，光看书还是很糊里糊涂的。