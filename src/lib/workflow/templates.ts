import {
  HANDLE,
  WORKFLOW_GRAPH_VERSION,
  createGenerateNode,
  createInputNode,
  createOutputNode,
  makeEdgeId,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from './types'

// ============================================================================
// 工作流模板
// ============================================================================

export type WorkflowTemplate = {
  id: string
  name: string
  description: string
  /** 每次调用都新建一份连好的节点图(节点 id 当次唯一)。 */
  build: () => WorkflowGraph
}

function connectImages(source: WorkflowNode, target: WorkflowNode): WorkflowEdge {
  return {
    id: makeEdgeId(source.id, target.id, HANDLE.OUT, HANDLE.GEN_IMAGES),
    source: source.id,
    target: target.id,
    sourceHandle: HANDLE.OUT,
    targetHandle: HANDLE.GEN_IMAGES,
  }
}

function connectOutput(source: WorkflowNode, target: WorkflowNode): WorkflowEdge {
  return {
    id: makeEdgeId(source.id, target.id, HANDLE.OUT, HANDLE.IN),
    source: source.id,
    target: target.id,
    sourceHandle: HANDLE.OUT,
    targetHandle: HANDLE.IN,
  }
}

// 详情页各分区的预置提示词(中文,电商详情页语境)。
const SECTIONS: Array<{ label: string; prompt: string }> = [
  {
    label: '主图 Banner',
    prompt:
      '参考第二张「参考详情页」的排版、配色与视觉风格,基于第一张产品图生成一张电商详情页顶部主图 Banner:' +
      '突出产品主体、构图居中留白,加入简洁有力的中文主标题与一句卖点短语,背景干净有质感。比例适配详情页顶部横幅。',
  },
  {
    label: '核心卖点',
    prompt:
      '参考详情页的风格,基于产品图生成一张「核心卖点」分区图:用 3-4 组「图标 + 短标题 + 一行说明」的网格排版' +
      '呈现产品卖点,中文文案,视觉风格与参考详情页保持统一,干净专业。',
  },
  {
    label: '使用场景',
    prompt:
      '基于产品图生成一张真实使用场景图:把产品自然融入贴合目标用户的生活 / 使用场景中,' +
      '光线真实、景深自然、构图专业,弱化广告感,适配详情页的场景展示分区。',
  },
  {
    label: '细节材质',
    prompt:
      '基于产品图生成一张产品细节特写 / 材质展示图:突出工艺、纹理与质感,微距视角,' +
      '配简短的中文细节说明标注,风格与参考详情页统一。',
  },
]

export const ECOMMERCE_DETAIL_TEMPLATE: WorkflowTemplate = {
  id: 'ecommerce-detail-clone',
  name: '电商详情页一键复刻',
  description: '上传产品图与一张参考详情页,自动生成主图 Banner、核心卖点、使用场景、细节材质四个分区,风格对齐参考页。',
  build(): WorkflowGraph {
    const product = createInputNode({ x: 40, y: 140 }, '产品图')
    const reference = createInputNode({ x: 40, y: 700 }, '参考详情页')
    const output = createOutputNode({ x: 1000, y: 520 }, '详情页素材')

    const nodes: WorkflowNode[] = [product, reference, output]
    const edges: WorkflowEdge[] = []

    SECTIONS.forEach((section, i) => {
      // 生成节点卡片较高(提示词 + 参数 + 结果区),纵向间距需 > 卡片高度以免重叠。
      const gen = createGenerateNode({ x: 480, y: i * 340 }, section.label, section.prompt)
      nodes.push(gen)
      // 产品图 + 参考详情页都作为图片输入喂给每个分区生成节点
      edges.push(connectImages(product, gen))
      edges.push(connectImages(reference, gen))
      // 各分区结果汇总到输出节点
      edges.push(connectOutput(gen, output))
    })

    return { version: WORKFLOW_GRAPH_VERSION, nodes, edges }
  },
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [ECOMMERCE_DETAIL_TEMPLATE]

/** 默认空白图(画布首次打开时)。 */
export function createBlankGraph(): WorkflowGraph {
  return { version: WORKFLOW_GRAPH_VERSION, nodes: [], edges: [] }
}
