---
title: 关于 Go 的内存管理这档事
published: 2025-12-12
description: 内存管理是 go 运行时的躯干，了解他有助于我们对 runtime 的深入理解。
tags:
  - Golang
  - 内存管理
category: 技术分享
draft: false
---
Go 语言里面，不论是堆还是栈，本质都是在操作系统的堆上进行分配的，本篇文章不会重点分析 Go 里面的多级缓存的内存分配模型，主要梳理一边堆栈内存的链路，来帮助我们把 Go 的 Runtime 串联起来，但是在梳理过程中，其实也能够看见多级缓存分配的身影。

## 1. 堆内存的分配链路

### 1.1 mallocgc 的入口

最适合入手进行分析的就是我们的 `mallocgc` 了，几乎所有的内存分配都要经过他，包括但不限于 channel，map，结构体的内存分配。（PS：这里的注释其实非常好玩，严肃批评了很多用 golinkname 技术来访问 go runtime 的内部细节的库，其中就包括字节的 sonic）
```go
// 分配一个指定大小的对象。
// 小对象从每个 P 的缓存空闲链表中分配。
// 大对象（大于 32 kB）直接从堆中分配。
func mallocgc(size uintptr, typ *_type, needzero bool) unsafe.Pointer {
	...

	// 剔除了不必要的部分，实际上我们只需要看他是如何分配内存的即可
	// 这里实际执行分配操作。
	var x unsafe.Pointer
	var elemsize uintptr
	if size <= maxSmallSize-gc.MallocHeaderSize {
		// 如果对象类型为 nil 或不含指针，分配小对象。
		if typ == nil || !typ.Pointers() {
			if size < maxTinySize {
				x, elemsize = mallocgcTiny(size, typ)
			} else {
				x, elemsize = mallocgcSmallNoscan(size, typ, needzero)
			}
		} else {
			// 如果对象包含指针且不需要零初始化，抛出异常。
			if !needzero {
				throw("objects with pointers must be zeroed")
			}
			// 如果该对象是堆段中的一部分，分配扫描小对象。
			if heapBitsInSpan(size) {
				x, elemsize = mallocgcSmallScanNoHeader(size, typ)
			} else {
				x, elemsize = mallocgcSmallScanHeader(size, typ)
			}
		}
	} else {
		// 分配大对象。
		x, elemsize = mallocgcLarge(size, typ, needzero)
	}
	...
	return x
}
```
我们可以发现，`mallocgc` 会根据分配对象的大小来选择合适的策略进行内存分配，看到这里，其实我们剩下的任务就是对三种分配策略进行分析了。
### 1.2 微小内存分配
首先是微小对象的分配，这个为了节省空间做了很强的优化：
```go
func mallocgcTiny(size uintptr, typ *_type) (unsafe.Pointer, uintptr) {
    mp := acquirem()
	...

	// Tiny allocator（微小对象分配器）
	//
	// tiny 分配器会把多个“极小”的分配请求合并到一个内存块里。
	// 只有当这个块里的所有子对象都不可达时，这个大块才会被释放。
	// 子对象必须是 noscan（不含指针），这样可以保证潜在浪费的内存有上界。
	//
	// 用于合并的块大小（maxTinySize）是可调的。
	// 当前设置 16 字节：对应最坏情况下 2 倍浪费（只剩 1 个子对象可达）。
	// 8 字节：几乎不浪费，但可合并机会更少。
	// 32 字节：合并机会更多，但最坏可到 4 倍浪费。
	// 最佳情况下的收益与块大小无关，最高可减少到 1/8（8x winning）。
	//
	// 从 tiny 分配器拿到的对象不能被显式 free。
	// 因此，如果一个对象将来会被显式 free，会保证它 size >= maxTinySize。
	//
	// SetFinalizer 对可能来自 tiny 分配器的对象有特殊处理：
	// 它允许给“一个大块内部的某个字节”设置 finalizer。
	//
	// tiny 分配器的主要目标：小字符串、以及单独逃逸到堆上的小变量。
	// 在某个 json benchmark 上，它把分配次数减少约 12%，堆大小减少约 20%。
	
	// 这里是获取了当前 m 对应的 p 所拥有的 mcache。
	c := getMCache(mp)
	off := c.tinyoffset

	...
	// 省略一些字节对齐操作

	// 这里算是一个比较核心的操作，这个 c.tiny 其实就是当前指向的
	// 最后一个 tiny 合并块，如果当前合并块能够放下这块需要分配的小内存，那么就
	// 会直接将内存分配到这块地方，如果不够，那么只能向后移动 tiny 合并块，来找到新的足够的待分配内存。
	// 值得注意的是，虽然 mcache 在多次分配之后肯定会已经分配了多个 tiny 块，但是此时只会这个 mcache
	// 只会指向最后一个块，即便之前的空间够分配，也不会将内存分配到之前的 tiny 合并块上。
	if off+size <= maxTinySize && c.tiny != 0 {
		// 这个对象能塞进现有的 tiny 块里，直接从现有块切一段出来。
		x := unsafe.Pointer(c.tiny + off)
		c.tinyoffset = off + size
		c.tinyAllocs++
		mp.mallocing = 0
		releasem(mp)
		return x, 0
	}

	// 这里就不能从当前的块找了，得从 span 里面再找一块空闲内存。
	checkGCTrigger := false
	span := c.alloc[tinySpanClass]
	v := nextFreeFast(span)
	if v == 0 {
		v, span, checkGCTrigger = c.nextFree(tinySpanClass)
	}
	x := unsafe.Pointer(v)

	// tiny 块总是按 16 字节（或 maxTinySize）大小分配，这里把它清零（总是零）。
	(*[2]uint64)(x)[0] = 0
	(*[2]uint64)(x)[1] = 0

	// 用新分配的 tiny 块替换旧的合并块
	if !raceenabled && (size < c.tinyoffset || c.tiny == 0) {
		c.tiny = uintptr(x)
		c.tinyoffset = size
	}

	...

	// 返回：对象指针 x，以及这个分配槽位的大小 span.elemsize
	return x, span.elemsize
}
```
这里涉及到了一些 sizeclass，其实就是将内存按照不同内存大小分块，然后把相同 size 的内存块放在一起的 class，针对于每个 class 的每个区块对应多大的内存，可以在 [src/internal/runtime/gc/sizeclasses.go](https://github.com/golang/go/blob/master/src/internal/runtime/gc/sizeclasses.go) 中找到答案，而这里的 tinyClass 为 2，tinySpanClass 为 5，所以对应的每个块是 16 个字节，在代码中除了翻译了一些注释，还添加了很多其他的说明，比如合并块逻辑的解释，这算是微内存分配的核心了。

其实在微内存分配的逻辑里面，去掉合并块的逻辑，其他逻辑和小内存分配大差不差，重点就是 `nextFreeFast` 和 `nextFree` 这两个函数，他们的实现还是很有意思的。
```go
// nextFreeFast 快速查找并返回下一个可用的空闲对象。
// 如果能快速找到，则返回该对象的指针；否则，返回 0。
func nextFreeFast(s *mspan) gclinkptr {
	// theBit 表示在 allocCache 里面最后一个为 0 的位置，即未分配的区块
	// 这里用了一个很高级的算法
	theBit := sys.TrailingZeros64(s.allocCache)

	// 如果 theBit 小于 64，表示在 allocCache 中找到了一个 1，即存在一个快速可用的空闲对象。
	if theBit < 64 {
		// result 计算出该空闲对象在整个 mspan 中的绝对索引。
		// s.freeindex 是当前 allocCache 位图所映射的 64 个对象的起始索引。
		// theBit 是该空闲对象在 allocCache 内部的偏移量。
		result := s.freeindex + uint16(theBit)

		// 检查计算出的对象索引是否在 mspan 的有效范围内 (小于总对象数 s.nelems)。
		if result < s.nelems {
			// freeidx 是分配该对象后，下一个对象的索引。
			freeidx := result + 1

			// 这是一个优化和边界条件处理：
			// 如果 freeidx 刚好是 64 的倍数 (即当前 allocCache 对应的 64 个槽位已用完)
			// 并且 freeidx 还没有达到 mspan 的末尾 (s.nelems)，
			// 那么当前 allocCache 无法再快速提供空闲对象，需要更复杂的分配逻辑（走慢路径）。
			// 此时返回 0，表示无法快速分配。
			if freeidx%64 == 0 && freeidx != s.nelems {
				return 0
			}

			// 将 s.allocCache 右移 (theBit + 1) 位。
			// 这会将刚刚分配的对象的位标记为已使用 (从位图中移除)，
			// 并将 allocCache 的“窗口”向前推进，以便下次从新的起始位开始查找。
			s.allocCache >>= uint(theBit + 1)

			// 更新 s.freeindex 为下一个可用的起始索引。
			s.freeindex = freeidx

			// 增加 mspan 中已分配对象的计数。
			s.allocCount++

			// 返回新分配对象的内存地址。
			// uintptr(result)*s.elemsize 计算对象相对于 mspan 基地址的偏移量。
			// s.base() 是 mspan 的起始内存地址。
			// gclinkptr 是 Go 运行时中用于表示指向 GC 对象的指针的类型。
			return gclinkptr(uintptr(result)*s.elemsize + s.base())
		}
	}
	return 0
}
```
代码很少，但是并不代表他好理解，`freeidx` 是当前 span 的分配位图中的绝对索引，表示当前 `s.allocCache` 的最后一个 bit 的绝对索引位，每次从 `allocCache` 中找到新的可分配的块时，就会将 `allocCache` 右移，意思是将右侧已经分配的块全部移除，同时将 `s.freeindex` 赋值为当前 `allocCache` 的最后一位 bit 的索引，我们的 `result` 变量其实就是 `freeidx`（绝对索引） + `theBit`（相对索引），就算之后已经移除的位已经回收空闲了，我们也不会去管他，而是直接从当前新的 bitmap 里面分配。

最终，我们当前的 bitmap 块已经用完的时候，会返回 0，此时会先扫描一下，是不是真的没有空闲的块了，如果没有，那么就会寻求分配一个新的 bitmap 块，这些逻辑都是在 `nextFree` 中实现的：
```go
// nextFree 函数从当前 mcache 中缓存的 span 中返回下一个空闲对象（如果可用）。
// 如果当前 span 已满，它会用一个含有可用对象的新 span 重新填充 mcache 的缓存，
// 并返回该对象，同时附带一个标志，表明这是一次“重量级”的内存分配。
// 如果是重量级分配，调用者必须判断是否需要启动一个新的 GC 周期，
// 或者如果 GC 正在活跃，该 goroutine 是否需要协助 GC。
//
// 此函数必须在不可抢占的上下文中运行，否则 mcache 'c' 的所有者可能会发生变化（导致并发问题）。
func (c *mcache) nextFree(spc spanClass) (v gclinkptr, s *mspan, checkGCTrigger *bool) {
	// 获取 mcache 为指定 spanClass (spc) 缓存的当前 mspan。
	s = c.alloc[spc]
	// 默认情况下，不需要检查 GC 触发器，即不是“重量级”分配。
	checkGCTrigger = false

	// 调用 mspan 的 nextFreeIndex 方法，从 span 里面获取下一个空闲对象的索引。
	freeIndex := s.nextFreeIndex()

	// 如果 freeIndex 等于 s.nelems，表示当前 mspan 已经完全满了，没有空闲对象。
	if freeIndex == s.nelems {
		// 检查 s.allocCount 是否确实等于 s.nelems。
		// 如果不相等，说明计数有问题，抛出运行时错误。
		if s.allocCount != s.nelems {
			println("runtime: s.allocCount=", s.allocCount, "s.nelems=", s.nelems)
			throw("s.allocCount != s.nelems && freeIndex == s.nelems")
		}

		// 当前 span 已满，需要重新填充 mcache。
		// c.refill(spc) 会从 mcentral 获取一个新的、有空闲对象的 mspan 来替换当前的。
		c.refill(spc)

		checkGCTrigger = true
		
		s = c.alloc[spc]
		freeIndex = s.nextFreeIndex()
	}

	...
}
```
这里的逻辑并不算复杂，重点在 `nextFreeIndex` 需要遍历当前 `span` 的所有区块来查找是否存在空闲块以及 `refill` 方法，它会从 `mcentral` 里面重新填充一份 `mspan` 到本地的 `mcache`，并且当前本地的 `mcache` 会归还给 `mcentral`。

首先我们可以先看看遍历当前 span 的 `nextFreeIndex`：
```go
// nextFreeIndex returns the index of the next free object in s at
// or after s.freeindex.
// There are hardware instructions that can be used to make this
// faster if profiling warrants it.

// nextFreeIndex 返回 mspan 's' 中，位于或开始于 s.freeindex 的下一个空闲对象的索引。
// 如果性能分析表明有必要，可以使用硬件指令来加速此过程。
func (s *mspan) nextFreeIndex() uint16 {
	...

	// 这里相当于重新走一遍 nextFreeFast 的逻辑
	aCache := s.allocCache
	bitIndex := sys.TrailingZeros64(aCache)

	// 如果 bitIndex 等于 64，表示当前的 aCache (64位) 已经全部是 0，没有空闲位了。
	// 加载 s.allocBits 中的下一段 64 位位图到 aCache。
	for bitIndex == 64 {
		// 将 freeindex 移动到下一个 64 位的起始位置。
		// (sfreeindex + 64) 向上取整到 64 的倍数。
		sfreeindex = (sfreeindex + 64) &^ (64 - 1) // 等同于 (sfreeindex + 63) / 64 * 64

		// 如果移动后的 sfreeindex 已经超出了 mspan 的总对象数，
		// 则说明整个 mspan 已经没有空闲对象了。
		if sfreeindex >= snelems {
			s.freeindex = snelems // 更新 mspan 的 freeindex 为末尾
			return snelems
		}

		// 计算需要从 s.allocBits 数组中加载的字节索引。
		// s.allocBits 是一个字节数组，每 8 个字节（64位）存储一个 allocCache。
		whichByte := sfreeindex / 8

		// 从 s.allocBits 中重新填充 s.allocCache。
		// 这会加载与 sfreeindex 对应的下一段 64 位空闲位图。
		s.refillAllocCache(whichByte)
		aCache = s.allocCache
		// 再次查找新加载的 aCache 中是否有空闲位。
		bitIndex = sys.TrailingZeros64(aCache)
		// 如果新的 aCache 仍然没有空闲位，继续循环，尝试加载再下一段。
	}

	// 找到了空闲位。计算该空闲对象在整个 mspan 中的绝对索引。
	result := sfreeindex + uint16(bitIndex)

	// 最终检查 result 是否超出了 mspan 的总对象数。
	if result >= snelems {
		s.freeindex = snelems
		return snelems
	}

	// 将 s.allocCache 右移 (bitIndex + 1) 位。
	// 这会“消耗”掉刚刚找到并标记为已使用的空闲位，同时将位图向前推进。
	s.allocCache >>= uint(bitIndex + 1)

	// 更新 sfreeindex 为下一个可能的空闲对象的起始索引。
	sfreeindex = result + 1

	// 如果 sfreeindex 达到了 64 的倍数，并且没有超出 mspan 总对象数，
	// 说明当前的 64 位 allocCache 已经用尽。
	if sfreeindex%64 == 0 && sfreeindex != snelems {
		// 计算需要从 s.allocBits 数组中加载的字节索引，以填充下一个 allocCache。
		whichByte := sfreeindex / 8
		// 重新填充 s.allocCache，准备处理下一个 64 位的对象块。
		s.refillAllocCache(whichByte)
	}

	// 更新 mspan 的 freeindex。
	s.freeindex = sfreeindex
	// 返回找到的空闲对象的绝对索引。
	return result
}
```
这里的逻辑是，将 freeidx 增加 64，也就是 64 bit，一个区块的长度，为什么要移动这里的 `freeidx`？其实很多人在这里有个误解，对于整个 mspan，并不是只有一个 64 位的 bitmap 块，而是多个 bitmap 块，形成了一个数组，而 `allocCache` 仅仅是当前正在使用 bitmap 块的视图，而不是仅有的一个，所以这里会后移 freeIdx，然后通过 `refillAllocCache` 将新的区块填充进去，如果实在没有新的区块了，那么就会通过之前提到的 `refill` 从 `mcentral` 里面找一块空闲的 `mspan` 来填充到本地，这样就能继续分配了。

下面来看看 `refill`：
```go
// refill 为 mcache 'c' 获取一个指定 spanClass (spc) 的新 mspan。
// 这个新的 mspan 至少会包含一个空闲对象。
// 调用此函数时，mcache 中当前对应 spc 的 span 必须是满的。
//
// 此函数必须在不可抢占的上下文中运行，否则 mcache 'c' 的所有者可能会发生变化（导致并发问题）。
func (c *mcache) refill(spc spanClass) {
	s := c.alloc[spc] // 获取 mcache 中当前为该 spanClass 缓存的 mspan。

	...
	// 这里省略一些关于 s 的校验

	// 如果当前 span 不是一个空的 mspan (emptymspan)，则进行处理。
	if s != &emptymspan {
		...
		// uncacheSpan 会将其从 mcache 中移除，并放入 mcentral 的相应列表中。
		mheap_.central[spc].mcentral.uncacheSpan(s)
		...
	}

	// cacheSpan 会从 mcentral 获取一个新的、有空闲对象的 mspan 来缓存到本地。
	s = mheap_.central[spc].mcentral.cacheSpan()

	...

	c.alloc[spc] = s
}
```
这里将 mspan 归还到 mcentral，然后还要再拿一块的代码太多了，这里直接贴出 `cacheSpan` 的代码：
```go
// 为 mcache 分配一个 span。
func (c *mcentral) cacheSpan() *mspan {
	// 扣除清扫信用（sweep credit），待会会详细讲。
    spanBytes := uintptr(gc.SizeClassToNPages[c.spanclass.sizeclass()]) * pageSize
    deductSweepCredit(spanBytes, 0)

    traceDone := false
    trace := traceAcquire()
    if trace.ok() {
        trace.GCSweepStart()
        traceRelease(trace)
    }

    // 如果在尝试了 spanBudget 个 span 后仍然没有找到 free object，
    // 就直接从 heap 分配一个新的 span。
    // 这样限制了查找时间，并使 sweeping 的成本被摊销。
    // 100 这个数字意味着只有 1% 的空间开销。
    spanBudget := 100

    var s *mspan
    var sl sweepLocker

    // 首先看看 “部分空闲”（部分清扫）的 mspan 集合里面有没有可用的 mspan
    // 它表示的是有空闲对象，且已经经过 gc 扫描回收过的 mspan
    sg := mheap_.sweepgen
    if s = c.partialSwept(sg).pop(); s != nil {
        goto havespan
    }

    // 如果上面的集合里面找不到，那么就会从部分未清扫的集合里面找，
    // 它表示的是还没有经过 gc 扫描回收，但是有一定的空闲空间的 mspan。
    sl = sweep.active.begin()
    if sl.valid {
        for ; spanBudget >= 0; spanBudget-- {
            s = c.partialUnswept(sg).pop()
            if s == nil {
                break
            }
            if s, ok := sl.tryAcquire(s); ok {
                // 成功获得这个 span 的所有权，执行 sweeping。
                s.sweep(true)
                sweep.active.end(sl)
                goto havespan
            }
        }

        // 实在找不到空闲的区域了，可以从全满但是还没有清扫的 mspan 集合中获取，
        // 因为经过清扫之后，可能会有空闲的空间。
        for ; spanBudget >= 0; spanBudget-- {
            s = c.fullUnswept(sg).pop()
            if s == nil {
                break
            }
            if s, ok := sl.tryAcquire(s); ok {
                // 成功获得该 span，进行 sweeping。
                s.sweep(true)
                // 检查 sweeping 后是否有 free slot。
                freeIndex := s.nextFreeIndex()
                if freeIndex != s.nelems {
                    s.freeindex = freeIndex
                    sweep.active.end(sl)
                    goto havespan
                }
                // sweeping 后仍无空位，将其放回 fullSwept 列表。
                c.fullSwept(sg).push(s.mspan)
            }
            // 同上，若无法获取 ownership，跳过。
        }
        sweep.active.end(sl)
    }

    // 真的一滴都不剩了，只能从堆里面分配了。
    trace = traceAcquire()
    if trace.ok() {
        trace.GCSweepDone()
        traceDone = true
        traceRelease(trace)
    }

    s = c.grow()
    if s == nil {
        return nil
    }

    // 至此一定有可用 span。
havespan:
	... 
	// 一些处理

    return s
}
```
我们可以从上面的代码窥见 go 的内存模型的多级缓存的框架，当然其中也蕴含了许多细节，包括，`mcentral` 里面为 `mspan` 列表做了分类处理，确保了 `mspan` 的分配高效，先从已经扫描的 `mspan` 集合里面找，然后从未扫描，但是有空闲空间的 `mspan` 里面寻找，当然，这种未扫描的 `mspan` 在获取的时候会进行清扫，如果还是没有，那么就会从未清扫并且 mspan 没有空闲空间的集合里面寻找，如果还是没有，那么就会通过 `grow` 方法从堆中分配空间。

在 `grow` 这个函数中，调用链路为 grow -> heap.alloc -> 系统栈调用 heap.allocSpan，系统栈调用是什么？其实就是通过 `systemstack` 来调用一个函数，他会切换到 g0 来执行这个函数，总之，在系统栈上执行的函数并不会被抢占或是调度，在 runtime 的很多地方都会去调用系统栈去执行一些操作，也就是会用到 g0 的地方。总之，这里会从堆中去分配 `mspan`。

#### 小结

当我们分配小内存的时候，会通过 `mallocgc` 中的 `mallocgcTiny` 尝试去分配一个微小内存，微小内存的分配做了一些优化，比如合并块，我们一个块的大小是 16 字节，因此在分配极小的对象时可能用不到一个块的大小的空闲，所以可以将多个极小的对象分配到一个块上。

如果此时这个块已经满了，就会通过 `nextFreeFast` 从 64 bit 的一个位图里面查找一个未分配的位，这个位通过计算可以对应到一个实际的块，如果当前位图已经没有可以分配的位，那么就会通过 `nextFree` 来获取新的 `allocCache` ，首先会通过 `nextFreeIndex` 来向后遍历 64 bit 的位图，并缓存到 `allocCache` 中，因为我们的 `mspan` 并不是只有一个 64 bit 位图，总体是形成了一个数组，当所有的位图都用完了，没办法，只能调用 `refill` 到 `mcentral` 上重新分配一个 `mspan`。

而我们的 `mcentral` 维护了不同类别的 `span` 集合，根据优先级依次从空闲已清理、空闲未清理、无空闲未清理集合里面找，如果没有任何可用的 `mspan`，就直接通过 `grow` 方法从堆中分配新的可用的 `mspan`。

其实我们微小内存的分配和小内存分配的链路大差不差，微小内存多了一个合并块逻辑，而小内存分配多了一个 spanClass 的计算，本质就是通过需要分配的内存大小计算一个 spanClass，确保分配的内存大小合适，这里就是一个块一个对象了，后续值得一提的就是大内存分配了，他会直接从堆内存中分配内存。

### 1.3 大内存分配

大内存分配 `mallocgcLarge` 会直接通过 `allocLarge` 从堆里面分配 npage 个大小的页。

```go
// allocLarge 为一个大对象分配一个内存块（span）。
// 这是 mcache 的一个方法，mcache 是每个处理器（P）本地的缓存，但大对象分配不经过 mcache，而是直接走向主堆 mheap。
func (c *mcache) allocLarge(size uintptr, noscan bool) *mspan {

	...
	// 计算 npages，就是 size 所需的页数量。

	// 扣除清扫信用（sweep credit），待会会详细讲。
	deductSweepCredit(npages*pageSize, npages)

	spc := makeSpanClass(0, noscan)

	// 从主堆（mheap）分配 npages 数量的连续内存页。
	s := mheap_.alloc(npages, spc)
	if s == nil {
		// 如果 mheap 返回 nil，说明物理内存不足。
		throw("out of memory") // 抛出内存溢出异常
	}

	...
	// 省略一些对我们来说不太重要的东西

	// 将这个新分配的大对象 span 放入 mcentral 的 "fullSwept" 列表中。
	// mcentral 是集中管理某种规格 span 的地方。
	// 这样做是为了让后台清扫器（background sweeper）能够看到并管理这个 span。
	mheap_.central[spc].mcentral.fullSwept(mheap_.sweepgen).push(s)

	...
	
	return s
}
```
我们看到这里可以知道，不论是大内存申请，还是小内存申请最终都会回到 `_mheap.alloc`，也就是从堆中申请内存，但是我们先不讲堆中的内存是如何申请的，想必在看代码的过程中，你已经注意到了有一个东西叫做清扫信用（sweep credit），这个东西你可能感觉有点熟悉，懂 GC 的朋友可能觉得这玩意不就是之前说过的 `assist credit` 吗？但是其实并不是，这个 `sweep credit` 和 `assist credit` 是两个不一样的东西，但都在垃圾回收里面起着一定的作用，下面我们可以看这个 `sweep credit` 有着什么样的作用。

### 1.4 SweepCredit

几乎所有的内存分配到最后都会调用 `deductSweepCredit`，他主要是在我们需要申请一个新的 `mspan` 时触发（包括向 `mcentral` 和堆申请 `mspan` 都会触发）：
```go
// deductSweepCredit 函数为分配一个大小为 spanBytes 的 span（内存块）扣除清扫信用。
// 这个操作必须在 span 被真正分配 *之前* 执行，以确保系统有足够的信用。
// 如果信用不足，它会强制执行清扫操作以避免进入“债务”状态。如果调用者自己也会
// 清扫一些页面（例如，在进行一次大内存分配时），它可以传递一个非零的 callerSweepPages
// 参数，这样函数会少计算这部分页面的清扫任务。
//
// deductSweepCredit 做了一个最坏情况的假设：即最终分配的 spanBytes 字节
// 将全部用于对象分配。
//
// deductSweepCredit 是“按比例清扫”（proportional sweep）系统的核心。
// 它利用垃圾收集器收集的统计数据来执行足够的清扫工作，以确保在两次 GC 周期
// 之间的并发清扫阶段，所有的内存页都能被清扫完毕。
//
// 调用此函数时，mheap_（内存堆）不能被锁定。
func deductSweepCredit(spanBytes uintptr, callerSweepPages uintptr) {
	...
retry:
	// 获取当前的清扫基准。这个基准是在上一次调整清扫步调时记录的已清扫页面数。
	sweptBasis := mheap_.pagesSweptBasis.Load()
	// 获取当前的堆上存活对象大小。
	live := gcController.heapLive.Load()
	// 获取计算清扫步调时使用的堆上存活对象大小的基准值。
	liveBasis := mheap_.sweepHeapLiveBasis

	// 估算新的堆大小。初始值是即将分配的 spanBytes。
	newHeapLive := spanBytes
	// 如果当前的存活对象大小 `live` 大于设置步调时的基准 `liveBasis`，
	// 说明在步调设置之后，又有新的对象被分配了。
	// 这部分增量也需要计入清扫任务。
	if liveBasis < live {
		// 加上这个增量 `live - liveBasis`。
		// 这里的代码是有意设计成有竞争条件的，在极少数情况下（例如并发调整GC参数），
		// `live` 可能小于 `liveBasis` 导致溢出。注释中提到，这是为了防止计算出一个
		// 巨大的 pagesTarget，从而卡在清扫循环里。如果发生这种情况，newHeapLive
		// 会是一个较小的值，本次清扫可能会被跳过，等待状态恢复正常。
		newHeapLive += uintptr(live - liveBasis)
	}

	// 计算目标需要清扫的页面数。
	// `mheap_.sweepPagesPerByte` 是一个比率，代表“每分配一字节内存，需要清扫多少页”。
	// `newHeapLive` 是估算的新增内存，乘以这个比率，就得到了需要完成的清扫页数。
	// `callerSweepPages` 是调用者承诺自己会清扫的页数，所以可以从目标中减去。
	pagesTarget := int64(mheap_.sweepPagesPerByte*float64(newHeapLive)) - int64(callerSweepPages)

	// 循环清扫，直到达到要求
	for pagesTarget > int64(mheap_.pagesSweEpt.Load()-sweptBasis) {
		// 调用 sweepone() 来清扫一个 span（通常包含多个页）。
		// 如果 sweepone() 返回 ^uintptr(0)，表示所有可清扫的 span 都已清扫完毕。
		if sweepone() == ^uintptr(0) {
			// 既然没东西可扫了，就将 sweepPagesPerByte 设为 0，禁用按比例清扫。
			mheap_.sweepPagesPerByte = 0
			// 跳出循环。
			break
		}

		// 在清扫过程中，GC 的步调可能会被其他 goroutine 改变（例如，通过 `runtime.GC()`）。
		// 如果 `pagesSweptBasis` 发生了变化，说明清扫的基准和目标已经过时。
		if mheap_.pagesSweptBasis.Load() != sweptBasis {
			// 必须重新计算债务。通过 goto retry 跳转回循环的开始。
			goto retry
		}
	}

	...
}
```
只有 AI 给的注释还是很难读，因为这里涉及到各种参数有点复杂，我总结了一下，大体逻辑其实就是这个函数的调用者会传入一个当前需要分配的字节数 `spanBytes`，和一个自己承诺会执行清理的页数 `callerSweepPages`（表示他自己会执行清理，这部分承诺的债务不会在当前函数中执行），然后我们会按照**每分配一个 byte 需要自己清理 `sweepPagesPerByte` 个页**的比例来偿还债务，然后这个函数会不断执行 `sweepone` 一直到债务还清或者没有任何页可以清理的时候，就会停止清理并跳出循环，执行下一步操作。

很显然我们可以知道，他主要是针对于 GC 的清扫阶段的债务，如果欠债，那么就要主动的去执行 `sweepone`，而之前所提到的 `assist credit` 主要是针对于 GC 的标记阶段，如果欠债了，那么就会主动挂起这个请求分配内存的 goroutine，等待其他生产者 goroutine 通过标记内存来生产债务，然后这些挂起的协程才可以被继续运行，他们的欠债机制和触发时机都是不一样的。

到目前为止，我们梳理完了 `mallocgc` 链路的比较核心的部分，其实我们目前可以大致看见堆内存的多级分配的大致框架，其实现在我们直接去看栈内存分配的代码会发现有很多重复的函数方法，这当然是因为我们的 goroutine 栈都是在操作系统的堆上分配的，对于栈内存管理，我们可以从 `stackalloc` 入手。

## 2. 栈内存管理

首先我们可以在 [/src/runtime/stack.go](https://github.com/golang/go/blob/master/src/runtime/stack.go#L344) 找到 `stackalloc` 的实现，我们在创建一个 goroutine 的时候，都会去使用 `stackalloc` 来为新的 goroutine 分配一个栈空间，参数则是固定的 2048 字节，也就是经典的 2kb。
```go
// stackalloc 分配一个 n 字节的栈。
//
// stackalloc 必须在系统栈上运行，因为它使用每个 P（处理器）
// 的资源，并且不能分割栈。
//
//go:systemstack
func stackalloc(n uint32) stack {
	// Stackalloc 必须在调度器栈上调用，这样我们
	// 在 stackalloc 运行的代码期间就永远不会尝试增长栈。
	// 这样做会导致死锁 (issue 1547)。
	
	...
	// 省略一些校验和 debug 代码。
	

	var v unsafe.Pointer
	if n < fixedStack<<_NumStackOrders && n < _StackCacheSize {
		// 如果需要的栈很小，会通过空闲列表分配器进行分配。
		order := uint8(0)
		n2 := n
		// 先根据尺寸定类别，到指定的列表分配。
		for n2 > fixedStack {
			order++
			n2 >>= 1
		}
		var x *gclinkptr
		if stackNoCache != 0 || thisg.m.p == 0 || thisg.m.preemptoff != "" {
			// thisg.m.p == 0 可能会在 exitsyscall 或 procresize 的内部发生。
			// 只需从全局池中获取一个栈。
			// 另外，在 gc 期间不要触碰 stackcache，
			// 因为它是并发刷新的。
			lock(&stackpool[order].item.mu)
			x = stackpoolalloc(order)
			unlock(&stackpool[order].item.mu)
		} else {
			c := thisg.m.p.ptr().mcache
			x = c.stackcache[order].list
			if x.ptr() == nil {
				// 如果没了，那就从上头分配一些内存到本地，和堆内存
				// 管理的 refill 逻辑差不多。
				stackcacherefill(c, order)
				x = c.stackcache[order].list
			}
			c.stackcache[order].list = x.ptr().next
			c.stackcache[order].size -= uintptr(n)
		}
		...
		v = unsafe.Pointer(x)
	} else {
		// 如果我们需要一个更大尺寸的栈，我们会去堆中到分配
		// 一个专用的 span，当然，肯定会有个缓存。
		var s *mspan
		// 计算需要多少页并对应到缓存的列表索引，作用类似 spanClass
		npage := uintptr(n) >> gc.PageShift
		log2npage := stacklog2(npage)

		// 尝试从大栈缓存中获取一个栈。
		lock(&stackLarge.lock)
		if !stackLarge.free[log2npage].isEmpty() {
			s = stackLarge.free[log2npage].first
			stackLarge.free[log2npage].remove(s)
		}
		unlock(&stackLarge.lock)

		lockWithRankMayAcquire(&mheap_.lock, lockRankMheap)
		if s == nil {
			// 从堆上分配一个新栈。
			s = mheap_.allocManual(npage, spanAllocStack)
			if s == nil {
				throw("out of memory")
			}
			osStackAlloc(s)
			s.elemsize = uintptr(n)
		}
		v = unsafe.Pointer(s.base())
	}

	...
	
	return stack{uintptr(v), uintptr(v) + uintptr(n)}
}

```
我们可以很清楚地看见，在进行栈分配的时候，会根据大小从不同的地方分配内存，需要的栈比较小的时候，会直接从 p 的本地 `mcache` 中的栈缓存获取，如果本地没有可以供分配的内存了，那么就会通过 `stackcacherefill` 从 `stackpool` 中获取栈内存来填充到本地，如果还是没有，那么会直接从堆内存中获取，也就是所谓的 `mheap.allocManual`；如果需要的栈很大，就会从大栈缓存中获取，如果没有，就会直接从堆中获取，也就是 `_mheap.allocManual` 他其实就是直接调用的 `allocSpan`，走的和我们堆内存管理都是一条路。

然后我们可以再去看看我们的 `newstack`，他主要是在函数调用的时候，`morestack` 判断需要进行栈扩容的时候就会调用 `newstack` 这个函数。
```go
// 当需要更多栈时，由 runtime·morestack 调用。
// 分配一个更大的栈并将内容迁移到新栈。
// 栈的增长是乘法式的，以获得均摊的常数成本。
//
// 进入时，g->atomicstatus 将为 Grunning 或 Gscanrunning。
// 如果调度器试图停止这个 g，它会设置 preemptStop。
//
// 这必须是 nowritebarrierrec，因为它可以作为
// 其他 nowritebarrierrec 函数栈增长的一部分被调用，但是
// 编译器不会检查这一点。
//
//go:nowritebarrierrec
func newstack() {
	...

	// 这里是一个 goroutine 抢占点
	preempt := stackguard0 == stackPreempt
	if preempt {
		if !canPreemptM(thisg.m) {
			// 暂时让 goroutine 继续运行。
			// gp->preempt 已被设置，所以它会在下一次被抢占。
			gp.stackguard0 = gp.stack.lo + stackGuard
			gogo(&gp.sched)
		}
	}

	...
	
	if preempt {
		if gp == thisg.m.g0 {
			throw("runtime: preempt g0")
		}
		if thisg.m.p == 0 && thisg.m.locks == 0 {
			throw("runtime: g is running but p is not")
		}

		if gp.preemptShrink {
			// 我们现在处于一个同步安全点，所以
			// 执行待处理的栈收缩操作。
			gp.preemptShrink = false
			shrinkstack(gp)
		}

		gp.syncSafePoint = true

		if gp.preemptStop {
			preemptPark(gp)
		}
		gopreempt_m(gp)
	}

	// 分配一个更大的段并移动栈。
	oldsize := gp.stack.hi - gp.stack.lo
	newsize := oldsize * 2

	...

	// 当我们进行复制时，并发 GC 不会扫描栈，因为
	// gp 处于 Gcopystack 状态。
	copystack(gp, newsize)

	if stackDebug >= 1 {
		print("stack grow done\n")
	}
	casgstatus(gp, _Gcopystack, _Grunning)
	gogo(&gp.sched)
}
```
`newstack` 最终会将通过 `copystack` 将旧的栈复制到新开辟的栈空间，当然在此之前也有一个协程的抢占点，这也是实现抢占式调度的其中一个关键点，如果没有被抢占，那么就可以直接执行栈增长的逻辑，我们的 `copystack` 会直接为新的尺寸通过 `stackalloc` 去分配栈内存，然后将旧的栈空间的数据复制到新的栈空间，这样就实现了栈的增长，栈缩小也是一样的逻辑，栈缩小最后调用的也是 `copystack`。

## 3. 结语

在阅读这部分源码的过程中，我们可以看见许多其他的运行时比如 GC、GMP 模型的身影，虽然没有事无巨细的去看每部分细节，但是这样我们也能很好地理解 runtime 中 go 的内存管理，还有经典的八股文 goroutine 的栈是在操作系统的堆上分配的这个逻辑。