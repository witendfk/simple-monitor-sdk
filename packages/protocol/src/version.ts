/**
 * 传输协议版本（契约的一部分，见 docs/SPEC.md 协议 v1）。
 *
 * - 字段新增（向后兼容）→ 版本不变；
 * - 字段删除/语义变更（破坏性）→ +1，接收端对不认识的大版本直接拒绝。
 *
 * SDK 发送端与接收端（apps/server）都必须引用本常量，禁止各自硬编码。
 */
export const PROTOCOL_VERSION = 1
