/**
 * PrintEngine.
 *
 * A regra central: reimprimir é papel, não fato. Um job novo aponta para o
 * MESMO documento — não cria venda, não emite nota, não movimenta estoque e
 * não gera receita.
 *
 * A segunda: `printed` só é gravado quando o transporte confirma. Marcar antes
 * faria o sistema afirmar que o cupom saiu enquanto a impressora estava sem
 * papel.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement, getBalance } = await import('../src/services/core/InventoryService.js');
const { createSale } = await import('../src/services/core/SalesService.js');
const { createQuote } = await import('../src/services/core/QuoteService.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const {
  advancePrintJob,
  createPrintJob,
  listPrintJobs,
  listPrinters,
  printReadiness,
  reprintJob,
  upsertPrinter,
} = await import('../src/services/core/PrintEngine.js');
const { renderDocument } = await import('../src/services/core/PrintRenderer.js');
const { generateVariants } = await import('../src/services/core/VariantService.js');

let companyId: string;
let userId: string;
let produto: string;
let saleId: string;
let saleNumber: number;

function receita(): number {
  const row = getConnection()
    .prepare(
      "SELECT COALESCE(SUM(settled_cents), 0) AS total FROM core_finance_entries WHERE company_id = ?",
    )
    .get(companyId) as { total: number };
  return row.total;
}

function vendas(): number {
  return (getConnection().prepare('SELECT COUNT(*) AS n FROM core_sales').get() as { n: number }).n;
}

beforeEach(async () => {
  ensureCoreSchema();
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Comércio Ltda',
    tradeName: 'Preço Justo',
  });
  userId = await upsertUser({ login: 'CAIXA', displayName: 'Caixa', password: 'senha-teste-123' });
  linkUserToCompany(userId, companyId, 'operador_caixa_loja', true);

  produto = String(
    createProduct(companyId, { name: 'Camiseta Polo', priceCents: 8900, barcode: '7891234567895' })
      .id,
  );
  applyMovement({
    companyId,
    productId: produto,
    movementType: 'in',
    quantity: 10,
    referenceType: 'entrada',
    referenceId: 'carga',
    userId,
  });

  const venda = createSale({
    companyId,
    userId,
    idempotencyKey: randomUUID(),
    items: [{ productId: produto, quantity: 2 }],
    payments: [{ method: 'dinheiro', amountCents: 20000 }],
  });
  saleId = venda.sale.id;
  saleNumber = venda.sale.number;
});

function enfileirar(overrides: Record<string, unknown> = {}) {
  return createPrintJob({
    companyId,
    userId,
    documentType: 'SALE_RECEIPT',
    documentId: saleId,
    payload: renderDocument(companyId, 'SALE_RECEIPT', saleId),
    ...overrides,
  } as Parameters<typeof createPrintJob>[0]);
}

describe('fila de impressão', () => {
  it('o job nasce pronto quando já traz o documento renderizado', () => {
    const job = enfileirar();
    expect(job.status).toBe('ready');
    expect(job.document_id).toBe(saleId);
    expect(job.payload).toContain('GRUPO SAMPAIO');
  });

  it('sem documento renderizado, o job fica pendente', () => {
    const job = createPrintJob({
      companyId,
      userId,
      documentType: 'SALE_RECEIPT',
      documentId: saleId,
    });
    expect(job.status).toBe('pending');
  });

  it('tipo de documento desconhecido é recusado', () => {
    expect(() =>
      createPrintJob({
        companyId,
        userId,
        documentType: 'BOLETO_FALSO' as never,
        documentId: saleId,
      }),
    ).toThrowError(/desconhecido/i);
  });
});

describe('estado do job', () => {
  it('o caminho normal vai até impresso', () => {
    const job = enfileirar();
    const imprimindo = advancePrintJob({ companyId, jobId: job.id, status: 'printing' });
    expect(imprimindo.attempts).toBe(1);

    const impresso = advancePrintJob({ companyId, jobId: job.id, status: 'printed' });
    expect(impresso.status).toBe('printed');
    expect(impresso.printed_at).toBeTruthy();
  });

  it('NÃO pula direto de pronto para impresso', () => {
    // Marcar impresso sem passar pelo transporte faria o sistema afirmar que o
    // cupom saiu quando a impressora podia estar sem papel.
    const job = enfileirar();
    expect(() =>
      advancePrintJob({ companyId, jobId: job.id, status: 'printed' }),
    ).toThrowError(/não pode ir para/i);
  });

  it('job impresso não muda mais de estado', () => {
    const job = enfileirar();
    advancePrintJob({ companyId, jobId: job.id, status: 'printing' });
    advancePrintJob({ companyId, jobId: job.id, status: 'printed' });
    expect(() =>
      advancePrintJob({ companyId, jobId: job.id, status: 'failed' }),
    ).toThrowError(/não pode ir para/i);
  });

  it('falha guarda o motivo e permite nova tentativa', () => {
    const job = enfileirar();
    advancePrintJob({ companyId, jobId: job.id, status: 'printing' });
    const falhou = advancePrintJob({
      companyId,
      jobId: job.id,
      status: 'failed',
      error: 'Impressora sem papel.',
    });
    expect(falhou.status).toBe('failed');
    expect(falhou.error).toBe('Impressora sem papel.');

    const denovo = advancePrintJob({ companyId, jobId: job.id, status: 'pending' });
    expect(denovo.status).toBe('pending');
  });

  it('cancelado não vira impresso', () => {
    const job = enfileirar();
    advancePrintJob({ companyId, jobId: job.id, status: 'cancelled' });
    expect(() =>
      advancePrintJob({ companyId, jobId: job.id, status: 'printing' }),
    ).toThrowError(/não pode ir para/i);
  });
});

describe('reimpressão é papel, não fato', () => {
  it('não cria venda, receita nem movimento de estoque', () => {
    const antesVendas = vendas();
    const antesReceita = receita();
    const antesEstoque = getBalance(companyId, produto);

    const job = enfileirar();
    reprintJob({ companyId, userId, jobId: job.id });
    reprintJob({ companyId, userId, jobId: job.id });

    expect(vendas()).toBe(antesVendas);
    expect(receita()).toBe(antesReceita);
    expect(getBalance(companyId, produto)).toBe(antesEstoque);
  });

  it('a segunda via aponta para a MESMA venda', () => {
    const job = enfileirar();
    const via2 = reprintJob({ companyId, userId, jobId: job.id });

    expect(via2.id).not.toBe(job.id);
    expect(via2.document_id).toBe(saleId);
    expect(via2.document_type).toBe(job.document_type);
  });

  it('a segunda via reimprime o MESMO papel, não um documento novo', () => {
    const job = enfileirar();
    const via2 = reprintJob({ companyId, userId, jobId: job.id });
    // Se o preço mudar depois, a segunda via continua sendo via do original.
    expect(via2.payload).toBe(job.payload);
  });

  it('a origem fica registrada e aponta sempre para o job original', () => {
    const job = enfileirar();
    const via2 = reprintJob({ companyId, userId, jobId: job.id });
    const via3 = reprintJob({ companyId, userId, jobId: via2.id });

    expect(via2.reprint_of).toBe(job.id);
    // A terceira via aponta para o original, não para a segunda: assim dá para
    // contar quantas vias saíram do documento.
    expect(via3.reprint_of).toBe(job.id);
  });

  it('todas as vias do documento ficam listadas juntas', () => {
    const job = enfileirar();
    reprintJob({ companyId, userId, jobId: job.id });
    expect(listPrintJobs(companyId, { documentId: saleId })).toHaveLength(2);
  });
});

describe('renderização', () => {
  it('o cupom traz a marca, a operação e os totais da venda', () => {
    const html = renderDocument(companyId, 'SALE_RECEIPT', saleId);
    expect(html).toContain('GRUPO SAMPAIO');
    expect(html).toContain('Preço Justo');
    expect(html).toContain(`#${saleNumber}`);
    expect(html).toContain('R$&nbsp;178,00'.replace('&nbsp;', ' '));
    expect(html).toContain('80mm');
  });

  it('o cupom mostra o troco quando houve', () => {
    const comTroco = createSale({
      companyId,
      userId,
      idempotencyKey: randomUUID(),
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 10000 }],
    });
    const html = renderDocument(companyId, 'SALE_RECEIPT', comTroco.sale.id);
    expect(html).toContain('TROCO');
  });

  it('o orçamento sai em A4 e diz que não reserva mercadoria', () => {
    const doc = createQuote({
      companyId,
      userId,
      kind: 'orcamento',
      items: [{ productId: produto, quantity: 3 }],
    });
    const html = renderDocument(companyId, 'QUOTE', doc.id);
    expect(html).toContain('A4');
    expect(html).toContain(`Orçamento nº ${doc.number}`);
    expect(html).toContain('não reservam mercadoria');
    expect(html).toContain('Gestão Empresarial');
  });

  it('a pré-venda diz que a mercadoria está reservada', () => {
    const doc = createQuote({
      companyId,
      userId,
      kind: 'pre_venda',
      items: [{ productId: produto, quantity: 1 }],
    });
    const html = renderDocument(companyId, 'PRE_SALE', doc.id);
    expect(html).toContain('mercadoria está reservada');
  });

  it('a etiqueta traz o EAN da própria peça', () => {
    const html = renderDocument(companyId, 'PRODUCT_LABEL', produto);
    expect(html).toContain('7891234567895');
    expect(html).toContain('50mm 30mm');
  });

  it('nome de produto com HTML não vira marcação na etiqueta', () => {
    const perigoso = String(
      createProduct(companyId, { name: '<script>alert(1)</script>', priceCents: 100 }).id,
    );
    const html = renderDocument(companyId, 'PRODUCT_LABEL', perigoso);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});

/**
 * A etiqueta antes imprimia o EAN como TEXTO — treze dígitos e nenhuma barra.
 * Servia para conferir com o olho e para nada mais: o leitor do balcão não lê
 * número impresso. E não trazia atributo nenhum, então numa arara de camisetas
 * as etiquetas de P, M e G eram indistinguíveis sem passar no leitor.
 */
describe('etiqueta de produto', () => {
  it('imprime BARRAS, não o número escrito', () => {
    const html = renderDocument(companyId, 'PRODUCT_LABEL', produto);
    expect(html).toContain('<svg');
    expect(html).toContain('<rect');
    // O número continua embaixo das barras — é o que permite digitar quando o
    // leitor falha. O que não pode é ser a ÚNICA forma do código na etiqueta.
    expect(html).toContain('7891234567895');
  });

  it('produto sem código de barras avisa em vez de sair em branco', () => {
    const semEan = String(
      createProduct(companyId, { name: 'Item sem EAN', priceCents: 500, barcode: null }).id,
    );
    const html = renderDocument(companyId, 'PRODUCT_LABEL', semEan);
    // Etiqueta com espaço vazio no lugar das barras seria colada assim mesmo.
    expect(html).toContain('SEM CÓDIGO DE BARRAS');
  });

  describe('atributos', () => {
    function variante(attrs: Record<string, string[]>): string {
      const modelo = String(
        createProduct(companyId, { name: 'Camiseta Gola V', priceCents: 4900 }).id,
      );
      const { created } = generateVariants({ companyId, productId: modelo, axes: attrs });
      return String(created[0].id);
    }

    it('a variante mostra tamanho e cor — é o que diferencia na arara', () => {
      const html = renderDocument(
        companyId,
        'PRODUCT_LABEL',
        variante({ tamanho: ['M'], cor: ['Azul'] }),
      );
      expect(html).toContain('Tamanho M');
      expect(html).toContain('Cor Azul');
    });

    it('o título é o nome do MODELO, sem repetir a grade', () => {
      const html = renderDocument(
        companyId,
        'PRODUCT_LABEL',
        variante({ tamanho: ['M'], cor: ['Azul'] }),
      );
      // A variante se chama "Camiseta Gola V · Azul · M". Numa etiqueta de
      // 50×30mm, o nome cheio mais a linha de atributos gastariam duas linhas
      // com a mesma informação.
      expect(html).toContain('Camiseta Gola V');
      expect(html).not.toContain('Camiseta Gola V · Azul · M');
    });

    it('não decide o que é roupa: imprime o atributo que o produto tiver', () => {
      // Maquiagem não tem tamanho, tem tom. A etiqueta não precisa saber disso
      // — lê o JSON do cadastro e mostra o que houver.
      const html = renderDocument(companyId, 'PRODUCT_LABEL', variante({ tom: ['Nude 02'] }));
      expect(html).toContain('Tom Nude 02');
      expect(html).not.toContain('Tamanho');
    });

    it('a variante carrega o PRÓPRIO EAN, não o do modelo', () => {
      // EAN válido e distinto do produto do setup — o cadastro recusa
      // duplicata, e é ela que garante que o leitor cai numa peça só.
      const EAN_MODELO = '7891234567901';
      const modelo = String(
        createProduct(companyId, { name: 'Regata', priceCents: 3900, barcode: EAN_MODELO }).id,
      );
      const { created } = generateVariants({
        companyId,
        productId: modelo,
        axes: { tamanho: ['G'] },
      });
      const html = renderDocument(companyId, 'PRODUCT_LABEL', String(created[0].id));
      // Etiqueta do G com o EAN do modelo faria o PDV vender o tamanho errado.
      expect(html).not.toContain(EAN_MODELO);
    });

    it('produto solto cai para marca e categoria', () => {
      const solto = String(
        createProduct(companyId, {
          name: 'Fone de Ouvido',
          priceCents: 12900,
          brand: 'JBL',
          category: 'Áudio',
        }).id,
      );
      const html = renderDocument(companyId, 'PRODUCT_LABEL', solto);
      expect(html).toContain('JBL');
      expect(html).toContain('Áudio');
    });

    it('atributo com JSON quebrado não impede a etiqueta de sair', () => {
      const p = String(createProduct(companyId, { name: 'Item', priceCents: 100 }).id);
      getConnection()
        .prepare('UPDATE core_products SET variant_attributes = ? WHERE id = ?')
        .run('{isso não é json', p);
      // O balcão precisa da etiqueta; cadastro torto não pode derrubar a
      // impressão do que está correto.
      const html = renderDocument(companyId, 'PRODUCT_LABEL', p);
      expect(html).toContain('Item');
      expect(html).toContain('50mm 30mm');
    });
  });

  /**
   * O DANFE passou a existir. Como o DANFCE, a fonte dele é o DOCUMENTO
   * FISCAL — desenhar a partir do id de uma venda produziria um papel com os
   * valores certos e uma nota que não existe.
   */
  it('DANFE não é desenhada a partir de uma venda, só de documento fiscal', () => {
    expect(() => renderDocument(companyId, 'DANFE', saleId)).toThrowError(
      /documento fiscal não encontrado/i,
    );
  });

  /**
   * O DANFCE passou a existir, mas a fonte dele é o DOCUMENTO FISCAL, nunca a
   * venda. Desenhar a partir do id de uma venda produziria um papel com os
   * valores certos e uma nota que não existe.
   */
  it('DANFCE não é desenhada a partir de uma venda, só de documento fiscal', () => {
    expect(() => renderDocument(companyId, 'DANFCE', saleId)).toThrowError(
      /documento fiscal não encontrado/i,
    );
  });

  it('documento de outra empresa não é renderizado', () => {
    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
    expect(() => renderDocument(outra, 'SALE_RECEIPT', saleId)).toThrowError(/não encontrada/i);
  });
});

describe('impressoras e prontidão', () => {
  it('sem impressora configurada, o estado é honesto', () => {
    const r = printReadiness(companyId);
    expect(r.configured).toBe(false);
    expect(r.readiness).toBe('READY_FOR_HARDWARE');
  });

  it('com impressora de navegador, a impressão é pela caixa de diálogo', () => {
    upsertPrinter({ companyId, name: 'Cupom balcão', kind: 'cupom', transport: 'browser' });
    const r = printReadiness(companyId);
    expect(r.configured).toBe(true);
    expect(r.readiness).toBe('BROWSER_ONLY');
    // Impressão silenciosa exige agente local — prometer isso seria mentira.
    expect(r.message).toMatch(/agente local/i);
  });

  it('agente local configurado ainda NÃO é homologado', () => {
    upsertPrinter({ companyId, name: 'Térmica 80mm', kind: 'cupom', transport: 'agent' });
    const r = printReadiness(companyId);
    expect(r.readiness).toBe('READY_FOR_HARDWARE');
    expect(r.readiness).not.toBe('HOMOLOGATED');
  });

  it('só existe uma impressora padrão por tipo', () => {
    upsertPrinter({ companyId, name: 'Cupom A', kind: 'cupom', isDefault: true });
    upsertPrinter({ companyId, name: 'Cupom B', kind: 'cupom', isDefault: true });

    const padroes = listPrinters(companyId).filter((p) => p.kind === 'cupom' && p.is_default === 1);
    expect(padroes).toHaveLength(1);
    expect(padroes[0].name).toBe('Cupom B');
  });

  it('o cupom vai para a impressora de cupom, não para a de etiqueta', () => {
    const etiqueta = upsertPrinter({ companyId, name: 'Etiquetas', kind: 'etiqueta' });
    const cupom = upsertPrinter({ companyId, name: 'Cupom', kind: 'cupom', isDefault: true });

    const job = enfileirar();
    expect(job.printer_id).toBe(cupom.id);
    expect(job.printer_id).not.toBe(etiqueta.id);
  });

  it('impressora sem nome é recusada', () => {
    expect(() => upsertPrinter({ companyId, name: '  ', kind: 'cupom' })).toThrowError(/nome/i);
  });
});

describe('layouts de OS, caixa e plaquinha', () => {
  /** A oficina oficial do Preço Justo (celulares), criada pela migração. */
  async function oficina(): Promise<string> {
    const { ensureOfficialWorkshops } = await import('../src/db/core-migrations.js');
    ensureOfficialWorkshops();
    const row = getConnection()
      .prepare('SELECT id FROM core_workshops WHERE company_id = ? LIMIT 1')
      .get(companyId) as { id: string } | undefined;
    return String(row?.id);
  }

  /**
   * A OFICINA — a operação que de fato usa plaquinha.
   *
   * Os dois casos da plaquinha usavam a empresa deste arquivo, que é a **Preço
   * Justo**, e a bancada dela é a de CELULARES: a rodada 18 já dizia que
   * celular não leva adesivo com QR, e este caminho de impressão era o único
   * gerador de plaquinha sem guarda nenhum — passava. Com o guarda da rodada
   * 53 no lugar, o cenário precisa da operação certa, e é ela que se monta
   * aqui.
   */
  async function oficinaDeVerdade(): Promise<{ companyId: string; workshopId: string; userId: string }> {
    const { ensureOfficialWorkshops, ensureOfficialTagCompanies } = await import(
      '../src/db/core-migrations.js'
    );
    const oficinaCo = upsertCompany({
      slug: 'oficina',
      legalName: 'Oficina Ltda',
      tradeName: 'Oficina',
      kind: 'workshop',
    });
    ensureOfficialWorkshops();
    ensureOfficialTagCompanies();
    const bancada = getConnection()
      .prepare("SELECT id FROM core_workshops WHERE slug = 'oficina-mobilidade'")
      .get() as { id: string };
    const mecanico = await upsertUser({
      login: 'MEC_IMPRESSAO',
      displayName: 'Mecânico',
      password: 'senha-teste-123',
    });
    linkUserToCompany(mecanico, oficinaCo, 'gerente_oficina', true);
    return { companyId: oficinaCo, workshopId: String(bancada.id), userId: mecanico };
  }

  async function cliente(nome = 'Cliente Teste'): Promise<string> {
    const { createCustomer } = await import('../src/services/core/CatalogService.js');
    return String(createCustomer(companyId, { name: nome } as never).id);
  }

  it('a OS sai em A4 com peças e totais', async () => {
    const { createOrder, addPart } = await import('../src/services/core/WorkshopCoreService.js');
    const os = createOrder({
      companyId,
      workshopId: await oficina(),
      userId,
      customerId: await cliente(),
      complaint: 'Não liga',
    } as Parameters<typeof createOrder>[0]);

    const html = renderDocument(companyId, 'WORKSHOP_OS', String(os.id));
    expect(html).toContain('A4');
    /*
      O DOCUMENTO É O MESMO DA TELA desde a rodada 54.

      A fila de impressão e o botão "Imprimir OS" entregam o papel de
      `ServiceOrderA4`: dois desenhos divergiriam no primeiro campo que alguém
      mudasse num só. O cabeçalho mudou junto — o número saiu de uma frase
      corrida ("nº 12") para o bloco grande no canto, que é onde o balcão
      procura.
    */
    expect(html).toContain('Ordem de serviço');
    expect(html).toContain(String(os.number));
    expect(html).toContain('Não liga');
    // A OS não é documento fiscal, e o papel precisa dizer isso.
    expect(html).toContain('não é documento fiscal');
    void addPart;
  });

  it('o fechamento de caixa sai em cupom com a diferença', async () => {
    const { openSession, closeSession } = await import('../src/services/core/CashService.js');
    const sessao = openSession({ companyId, userId, openingCents: 10000 });
    closeSession({ companyId, sessionId: sessao.id, countedCents: 9500, userId });

    const html = renderDocument(companyId, 'CASH_CLOSING', sessao.id);
    expect(html).toContain('FECHAMENTO DE CAIXA');
    expect(html).toContain('80mm');
    // Contou menos que o esperado: é FALTA, e a palavra tem que aparecer.
    expect(html).toContain('FALTA');
    expect(html).toContain('Assinatura do responsável');
  });

  it('a plaquinha traz QR de verdade e o #ID legível', async () => {
    const { createEquipment } = await import('../src/services/core/EquipmentService.js');
    const { createCustomer } = await import('../src/services/core/CatalogService.js');
    const of = await oficinaDeVerdade();
    const eq = createEquipment({
      companyId: of.companyId,
      workshopId: of.workshopId,
      userId: of.userId,
      origin: 'EXTERNAL_CUSTOMER',
      ownerCustomerId: String(createCustomer(of.companyId, { name: 'Dono do patinete' } as never).id),
      brand: 'Xiaomi',
      model: 'M365',
    } as Parameters<typeof createEquipment>[0]);

    const html = renderDocument(of.companyId, 'EQUIPMENT_QR_TAG', String(eq.id));

    // QR desenhado no servidor, em vetor — PNG redimensionado em térmica perde
    // os módulos e o leitor não lê.
    expect(html).toContain('<svg');
    expect(html).toContain('<rect');
    expect(html).toContain('Xiaomi');
    expect(html).toMatch(/#\d{4}/);
  });

  it('o QR da plaquinha NÃO expõe dado do dono', async () => {
    const { createEquipment } = await import('../src/services/core/EquipmentService.js');
    const { createCustomer } = await import('../src/services/core/CatalogService.js');
    const of = await oficinaDeVerdade();
    const dono = createCustomer(of.companyId, {
      name: 'Maria Aparecida da Silva',
      phone: '11988887777',
      document: '11144477735',
    } as Parameters<typeof createCustomer>[1]);

    const eq = createEquipment({
      companyId: of.companyId,
      workshopId: of.workshopId,
      userId: of.userId,
      origin: 'EXTERNAL_CUSTOMER',
      ownerCustomerId: String(dono.id),
      brand: 'Xiaomi',
    } as Parameters<typeof createEquipment>[0]);

    const html = renderDocument(of.companyId, 'EQUIPMENT_QR_TAG', String(eq.id));

    // A plaquinha fica colada num equipamento que circula pela rua: quem
    // apontar a câmera não pode descobrir quem é o dono.
    expect(html).not.toContain('Maria Aparecida');
    expect(html).not.toContain('11988887777');
    expect(html).not.toContain('11144477735');
  });

  /**
   * A FILA DE IMPRESSÃO TAMBÉM OBEDECE À REGRA DE OURO (rodada 53).
   *
   * Este caminho era o único gerador de plaquinha SEM guarda nenhum do
   * sistema: `POST /core/print/jobs` com `EQUIPMENT_QR_TAG` aceita perfis de
   * loja, e daqui saía adesivo com QR sem passar nem pela regra da bancada
   * (rodada 18) nem pela da empresa. Que nenhuma tela chamasse este caminho
   * não era defesa — rota aberta é rota que alguém acha.
   *
   * Os dois casos acima são a prova pelo lado que PASSA; este é o lado que
   * recusa, e sem ele a regra ficaria sem quem a cobrasse aqui.
   */
  it('a fila de impressão recusa plaquinha de quem não usa plaquinha', async () => {
    const { createEquipment } = await import('../src/services/core/EquipmentService.js');
    const of = await oficinaDeVerdade();
    const eq = createEquipment({
      companyId: of.companyId,
      workshopId: of.workshopId,
      userId: of.userId,
      origin: 'INTERNAL_PJ_MOTORS',
      brand: 'Shineray',
      model: 'PT2',
    } as Parameters<typeof createEquipment>[0]);

    // A Oficina imprime.
    expect(() => renderDocument(of.companyId, 'EQUIPMENT_QR_TAG', String(eq.id))).not.toThrow();

    // A loja de variedades deste arquivo, não — e a recusa diz por quê.
    getConnection()
      .prepare('UPDATE core_companies SET uses_equipment_tags = 0 WHERE id = ?')
      .run(of.companyId);
    let recusa: unknown;
    try {
      renderDocument(of.companyId, 'EQUIPMENT_QR_TAG', String(eq.id));
    } catch (err) {
      recusa = err;
    }
    expect((recusa as { code?: string })?.code).toBe('CORE_COMPANY_NO_TAGS');
  });
});
