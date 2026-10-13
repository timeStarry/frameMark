package clock

import "time"

// 默认真实时间；测试经各包 Deps.Now 注入，不改这个全局量。
var Now = func() int64 { return time.Now().UnixMilli() }
