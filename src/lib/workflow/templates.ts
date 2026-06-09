import {
  HANDLE,
  WORKFLOW_GRAPH_VERSION,
  createGenerateNode,
  createInputNode,
  createOutputNode,
  createTextNode,
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

function connectPrompt(source: WorkflowNode, target: WorkflowNode): WorkflowEdge {
  return {
    id: makeEdgeId(source.id, target.id, HANDLE.OUT, HANDLE.GEN_PROMPT),
    source: source.id,
    target: target.id,
    sourceHandle: HANDLE.OUT,
    targetHandle: HANDLE.GEN_PROMPT,
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

const VIRTUAL_TRY_ON_PROMPT =
  '基于两张输入图生成一张竖版服装试穿海报。第一张是「服装正视图」,第二张是「模特样貌参考」。' +
  '请让第二张参考中的模特自然穿上第一张服装,严格保留服装的颜色、版型、图案、面料质感、领口/袖口/下摆等关键结构,不要改成其他款式。' +
  '保留模特的五官、发型、肤色、体型比例与气质,只替换对应服装部位;如果服装是上衣/裤装/连衣裙/外套,按品类合理搭配其余服饰。' +
  '画面为高级电商或时尚品牌海报:人物居中,全身或膝上构图,姿态自然,布料贴合身体并有真实褶皱,光线干净,背景简洁有层次,留出可加字的海报留白。' +
  '不要生成水印、Logo、乱码文字、额外人物、重复肢体、畸形手指或不合理穿搭。'

export const VIRTUAL_TRY_ON_POSTER_TEMPLATE: WorkflowTemplate = {
  id: 'virtual-try-on-poster',
  name: '虚拟试衣海报',
  description: '上传 1 张服装正视图与 1 张模特样貌参考图,生成模特穿上该服装的竖版海报。',
  build(): WorkflowGraph {
    const garment = createInputNode(
      { x: 40, y: 120 },
      '服装正视图',
      {
        description: '上传单件衣服的正面图,白底、平铺或挂拍都可以。',
        maxImages: 1,
      },
    )
    const model = createInputNode(
      { x: 40, y: 390 },
      '模特样貌参考',
      {
        description: '上传模特头像、半身或全身照,用于固定五官、发型、气质与体型。',
        maxImages: 1,
      },
    )
    const prompt = createTextNode({ x: 390, y: 80 }, '海报要求', VIRTUAL_TRY_ON_PROMPT)
    const generate = createGenerateNode(
      { x: 390, y: 340 },
      '试衣海报',
      '',
      { size: '1024x1536', quality: 'high', n: 1 },
    )
    const output = createOutputNode({ x: 780, y: 360 }, '海报成片')

    const nodes: WorkflowNode[] = [garment, model, prompt, generate, output]
    const edges: WorkflowEdge[] = [
      connectImages(garment, generate),
      connectImages(model, generate),
      connectPrompt(prompt, generate),
      connectOutput(generate, output),
    ]

    return { version: WORKFLOW_GRAPH_VERSION, nodes, edges }
  },
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

const VIDEO_STORYBOARD_PROMPT =
  '基于产品图生成一组短视频关键帧分镜。目标是 6-10 秒电商短视频:开场必须看清商品主体,中段突出材质/功能细节,结尾给出生活方式或使用场景。' +
  '每张图都要保持同一产品外观、颜色、比例与材质一致,镜头语言稳定,背景干净,适合后续作为视频生成参考图。不要添加水印、Logo、乱码文字或无关人物。'

const STORYBOARD_SECTIONS: Array<{ label: string; prompt: string; position: { x: number; y: number } }> = [
  {
    label: '开场定帧',
    position: { x: 470, y: 40 },
    prompt: '生成短视频第 1 个关键帧:商品主体居中,完整可见,背景干净,光线有立体感,适合作为视频开场画面。',
  },
  {
    label: '细节推进',
    position: { x: 470, y: 350 },
    prompt: '生成短视频第 2 个关键帧:镜头推进到商品关键细节,突出材质、工艺或功能卖点,构图稳定,与开场定帧保持同一产品一致性。',
  },
  {
    label: '场景收束',
    position: { x: 470, y: 660 },
    prompt: '生成短视频第 3 个关键帧:把商品放入真实使用或生活方式场景,主体仍清楚,环境自然克制,适合作为短视频结尾画面。',
  },
]

export const VIDEO_STORYBOARD_TEMPLATE: WorkflowTemplate = {
  id: 'video-storyboard',
  name: '商品短视频分镜',
  description: '上传产品图,生成开场、细节推进、场景收束 3 张短视频关键帧,用于后续视频模式参考。',
  build(): WorkflowGraph {
    const product = createInputNode(
      { x: 40, y: 310 },
      '产品图',
      {
        description: '上传要制作短视频的商品图,最好主体清晰、边缘完整。',
        maxImages: 1,
      },
    )
    const prompt = createTextNode({ x: 40, y: 610 }, '分镜约束', VIDEO_STORYBOARD_PROMPT)
    const output = createOutputNode({ x: 880, y: 400 }, '视频关键帧')

    const nodes: WorkflowNode[] = [product, prompt, output]
    const edges: WorkflowEdge[] = []

    STORYBOARD_SECTIONS.forEach((section) => {
      const gen = createGenerateNode(
        section.position,
        section.label,
        section.prompt,
        { size: '1024x1024', quality: 'high', n: 1 },
      )
      nodes.push(gen)
      edges.push(connectImages(product, gen))
      edges.push(connectPrompt(prompt, gen))
      edges.push(connectOutput(gen, output))
    })

    return { version: WORKFLOW_GRAPH_VERSION, nodes, edges }
  },
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [VIRTUAL_TRY_ON_POSTER_TEMPLATE, ECOMMERCE_DETAIL_TEMPLATE, VIDEO_STORYBOARD_TEMPLATE]

/** 默认空白图(画布首次打开时)。 */
export function createBlankGraph(): WorkflowGraph {
  return { version: WORKFLOW_GRAPH_VERSION, nodes: [], edges: [] }
}
