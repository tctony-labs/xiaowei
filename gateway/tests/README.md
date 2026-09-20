# Gateway 共享验收

`wire-cases.json` 由 Rust `tests/core.rs` 和 TS `test/core.test.ts` 共同执行，覆盖空 PB message、uint64 上限和损坏 wire。复杂 optional／oneof／2 MiB bytes 往返使用 Plan 00 的 `testing.Fixture` 契约，在 TS `test/transport.test.ts` 与 Rust `examples/fixture_transport.rs` 间执行；测试 service 不向产品注册。

Rust `tests/core.rs` 保留旧 invoke／event 测试覆盖的注册、typed 参数、远端回退、并发、filter、Ordered burst、backend 订阅保留／解绑、旧连接投递和 owner 清理语义；以 PB 和注入 transport／sink 替换旧 JSON／Tauri／socket 装配。新增批内重名、跨 routes／events 原子性、超时后真实任务占用、连接替换与迟到结果、白名单及协议兼容测试。两端有编译期错误入参／返回值反例。
