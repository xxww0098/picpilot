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
  platform: '通用' | '独立站' | 'Ozon'
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
  platform: '通用',
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
  platform: '独立站',
  name: '独立站详情页复刻',
  description: '上传产品图与一张参考详情页,自动生成主图 Banner、核心卖点、使用场景、细节材质四个分区,适合 Shopify/自营站详情页。',
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

const OZON_SAMPLE_PRODUCT_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAACgCAYAAACLz2ctAAACmElEQVR42u3cMUoDQRSA4ZzF3trCC3gWL6B1Co9g4y08hZ2djSBiFbCzEMUiEjvBwE7mzc4673vwtxM2fJCd3c2uPj6/tlKvVr4EASgAJQAFoASgAJQAFIASgAJQAlAASgAKQAlAASgBKAAlAAWgBKAAlAAUgBKAAlACUABKAApACUABKACHOqCj88ehAxBAAAEEEEAAAQQQQACTAzxdvwM4IsDL9fWf9QS4wzY1AAHsAq81RAAT/QTXwGsFEcAkACPxRSIEMAHAFviiEAI4OMCW+CIQAgjgr3YDIIAhAEvQ7ZvWCAFMDLBkAASwG76WCAEEEEAA5wVYMwACCCCAAAKYBOD9w3MokoiJWn93bAAOCLAlwsh1AQQQQAABBDAZwFbXAQEEEEAAlwEwGkwL0AAmBxj5NAyAAFYBqnke8NABEMCQAASwG8KaATAJwFYIawfARACjEUYMgAMBvL17nVwNvKmfAWBCgJu3bVEl8ErWBRDAgyvFBiCAoQAjAhBAAAEEEEAAAQQQwBqA+17sOfUFnwACCCCAAAK4oDshc+Qc0L3gxQ+AAAIIIIAAAggggAACCCCAANYDPD456xKAAAIIIIAAAggggAACaBdsFwwggAACCCCAAAIIIIAAzgvw4uqmaQACCCCAAAIIIIAA2oQACCCAAAII4MKb+mdrAAEEEEAAAQTQOSCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAjgGwJED8J/09LIZNgDBAxHAvPBGQggggAACCCCAAAIIIIAgwgcgiK4DAgkcgBo/AAWgAJQAFIASgAJQAlAASgAKQAlAASgBKAAlAAWgBKAAlAAUgBKAAlACUABKAApACUABKAEoAKWfvgGDrzq/yG3SbgAAAABJRU5ErkJggg=='

const OZON_SHARED_PROMPT =
  'Ozon 上架图片统一约束:严格保留输入商品的外观、颜色、比例、材质和关键结构;不要更换品牌、包装、配件或功能形态。' +
  '主图优先按 Ozon 商品卡片的 3:4 竖图思路组织画面,主体完整清晰,背景干净,避免裁切边缘。' +
  '生成结果必须无水印。不要出现价格、折扣、联系方式、社交账号或外部链接;不要生成 Logo 叠加、二维码、边框、平台 UI、乱码文字或虚假认证标识。'

const OZON_SECTIONS: Array<{ label: string; prompt: string; size: string; position: { x: number; y: number } }> = [
  {
    label: 'Ozon 主图 3:4',
    size: '1024x1536',
    position: { x: 500, y: 0 },
    prompt:
      '为 Ozon 商品卡片生成主图。画面比例 3:4 竖图,纯白或极浅灰背景,商品居中完整展示,占画面大约 80%-90%,边缘留少量安全边距。' +
      '只展示商品本体和必要随附件,不加促销文案、卖点字、贴纸、装饰图形、人物、阴影过重的场景或额外道具。输出应像可直接上传的 Ozon 主图。',
  },
  {
    label: 'Ozon Fresh 方图',
    size: '1024x1024',
    position: { x: 500, y: 320 },
    prompt:
      '生成 Ozon Fresh / 食品类兼容的 1:1 方形主图版本。白底或透明感白底,商品完整清晰,主体居中,包装文字尽量真实但不要新增不存在的文字。' +
      '不加入促销标签、价格、折扣、联系方式、水印或边框,适合需要方图的 Ozon 类目或跨平台备用。',
  },
  {
    label: 'Ozon 场景附图',
    size: '1024x1536',
    position: { x: 500, y: 640 },
    prompt:
      '生成 Ozon 商品页附图中的使用场景图。保留同一商品外观,把商品放入真实、克制、可信的使用环境中,帮助买家理解尺寸、使用方式和目标场景。' +
      '可以有自然道具或手部互动,但商品必须清楚可识别,不要出现价格、联系方式、外链、水印或夸张广告字。',
  },
  {
    label: 'Ozon 细节附图',
    size: '1024x1536',
    position: { x: 500, y: 960 },
    prompt:
      '生成 Ozon 商品页附图中的细节材质图。使用近景或局部特写突出材质、做工、接口、纹理、容量、包装细节或功能结构。' +
      '允许少量中文或俄文风格短标注,但不要新增虚假参数、认证、奖章或无法从商品确认的信息;不要出现价格、折扣、联系方式、社交账号或外部链接。',
  },
  {
    label: 'Ozon 信息图',
    size: '1024x1536',
    position: { x: 500, y: 1280 },
    prompt:
      '生成 Ozon 商品页信息图附图。以商品为中心,用 3-5 个清晰卖点模块说明真实优势,版式干净,适合俄语/中文卖点本地化后替换文字。' +
      '信息图可以有短标题、箭头和局部放大,但不要出现价格、折扣、联系方式、社交账号、外部链接、水印、二维码或虚假认证。',
  },
]

export const OZON_LISTING_ASSET_TEMPLATE: WorkflowTemplate = {
  id: 'ozon-listing-asset-pack',
  platform: 'Ozon',
  name: 'Ozon 上架图组',
  description: '按 Ozon 商品卡片与商品页附图拆分:3:4 主图、Fresh 方图、场景、细节、信息图。内置一张示例商品图,可直接替换。',
  build(): WorkflowGraph {
    const product = createInputNode(
      { x: 40, y: 260 },
      '示例商品图',
      {
        description: '内置示例用于理解流程;实际使用时替换为商品白底图、包装图或清晰实拍图。',
        maxImages: 1,
      },
    )
    product.data.images = [{ id: 'ozon-sample-product', dataUrl: OZON_SAMPLE_PRODUCT_IMAGE }]

    const reference = createInputNode(
      { x: 40, y: 600 },
      '品牌/类目参考',
      {
        description: '可选:上传竞品图、品牌视觉或类目参考。没有参考图也能运行。',
        maxImages: 4,
      },
    )
    const prompt = createTextNode({ x: 40, y: 940 }, 'Ozon 平台约束', OZON_SHARED_PROMPT)
    const output = createOutputNode({ x: 940, y: 690 }, 'Ozon 上架图组')

    const nodes: WorkflowNode[] = [product, reference, prompt, output]
    const edges: WorkflowEdge[] = []

    OZON_SECTIONS.forEach((section) => {
      const gen = createGenerateNode(
        section.position,
        section.label,
        section.prompt,
        { size: section.size, quality: 'high', n: 1 },
      )
      nodes.push(gen)
      edges.push(connectImages(product, gen))
      edges.push(connectImages(reference, gen))
      edges.push(connectPrompt(prompt, gen))
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
  platform: '通用',
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

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  OZON_LISTING_ASSET_TEMPLATE,
  VIRTUAL_TRY_ON_POSTER_TEMPLATE,
  ECOMMERCE_DETAIL_TEMPLATE,
  VIDEO_STORYBOARD_TEMPLATE,
]

/** 默认空白图(画布首次打开时)。 */
export function createBlankGraph(): WorkflowGraph {
  return { version: WORKFLOW_GRAPH_VERSION, nodes: [], edges: [] }
}
