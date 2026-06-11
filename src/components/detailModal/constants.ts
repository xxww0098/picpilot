// 详情弹窗一次可能要解码多张输入/输出图：限制并发，避免 10+ 张同时解码造成卡顿。
export const IMAGE_DECODE_CONCURRENCY = 4
