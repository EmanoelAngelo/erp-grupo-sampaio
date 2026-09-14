/**
 * A plaquinha sai do navegador e passa a ser medida em milímetro.
 *
 * ## O que estava errado
 *
 * A rota devolvia dados e a TELA montava o adesivo em pixels — `w-[170px]`,
 * `text-[22px]`. O que saía da impressora não tinha tamanho físico previsível:
 * dependia da margem e do zoom do navegador. E a plaquinha precisa caber num
 * espaço fixo, colada num equipamento.
 *
 * ## Por que os testes daqui são GEOMÉTRICOS
 *
 * Conferir string de HTML não vê o defeito que mais dói. Numa célula de 25 mm
 * com `overflow: hidden`, um QR empilhado sobre o texto empurra o número da
 * plaquinha para fora do papel — e o HTML continua contendo o número. O teste
 * passaria, e o adesivo sairia sem o `#000N`, que é o resgate humano de quando
 * o QR não lê.
 *
 * Então as asserções são sobre MEDIDA: o QR cabe na altura, o módulo não fica
 * abaixo do piso de leitura, e as colunas não estouram a folha.
 */
import { describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { desenharQr, MODULOS_DE_SILENCIO } = await import('../src/services/core/Qr.js');
const {
  EQUIPMENT_TAG_FORMATS,
  MODULO_MINIMO_MM,
  SEGURANCA_DE_CORTE_MM,
  escalaDaPlaquinha,
  equipmentTagFormat,
} = await import('../src/services/core/EquipmentTagFormats.js');
const { larguraOcupadaMm, alturaOcupadaMm } = await import(
  '../src/services/core/LabelFormats.js'
);

/** Um endereço realista: o QR da plaquinha carrega base + token de 32 chars. */
const URL_TIPICA = 'https://grupossampaio.com.br/equipamento/' + 'a'.repeat(32);

describe('o gerador de QR é um só', () => {
  it('a zona de silêncio é a da norma, e entra no viewBox', () => {
    const qr = desenharQr('teste');
    // Quatro módulos de cada lado. Abaixo disso muitos leitores não acham o
    // código — e a plaquinha é lida por celular de cliente.
    expect(MODULOS_DE_SILENCIO).toBe(4);
    expect(qr.lado).toBe(qr.modulos + 8);
    expect(qr.svg).toContain(`viewBox="0 0 ${qr.lado} ${qr.lado}"`);
  });

  /**
   * Um módulo por retângulo é o desenho óbvio e custa caro em folha: são ~690
   * módulos escuros por plaquinha, e uma folha de vinte vira megabytes de HTML
   * trafegando dentro de JSON.
   */
  it('desenha por corrida horizontal, e não um retângulo por módulo', () => {
    const qr = desenharQr(URL_TIPICA);
    expect(qr.svg).not.toContain('<rect x=');
    expect(qr.svg).toContain('<path');

    // O ganho é a razão de o desenho ter mudado: se um dia voltar a inchar,
    // este caso avisa antes de a folha ficar impraticável.
    const modulosEscuros = qr.modulos * qr.modulos * 0.45;
    expect(qr.svg.length).toBeLessThan(modulosEscuros * 30);
  });

  it('nível de correção diferente muda o símbolo', () => {
    // Mais correção custa módulos: o código fica mais denso no mesmo espaço, e
    // é por isso que o nível é decidido por formato, não cravado.
    const m = desenharQr(URL_TIPICA, { nivel: 'M' });
    const h = desenharQr(URL_TIPICA, { nivel: 'H' });
    expect(h.modulos).toBeGreaterThan(m.modulos);
  });

  it('o tamanho em pixels é opcional — o cupom fiscal depende dele', () => {
    expect(desenharQr('x').svg).not.toContain('width="140"');
    expect(desenharQr('x', { px: 140 }).svg).toContain('width="140"');
  });
});

describe('a geometria de cada formato fecha no papel', () => {
  for (const f of EQUIPMENT_TAG_FORMATS) {
    describe(f.id, () => {
      it('as colunas não estouram a largura da página', () => {
        // Em rolo a margem é INTERNA à etiqueta, então ela não conta como
        // largura ocupada da página — a página É a etiqueta.
        const limite = f.midia === 'folha' ? 210 : f.columns * f.widthMm + f.marginLeftMm + 0.01;
        expect(larguraOcupadaMm(f)).toBeLessThanOrEqual(limite);
      });

      it('as linhas não estouram a altura da página', () => {
        if (f.midia !== 'folha') return;
        expect(alturaOcupadaMm(f)).toBeLessThanOrEqual(297);
      });

      /**
       * O caso que mais importa: o QR CABE na altura da célula, com a folga de
       * corte reservada. Sem isto, a tesoura passa dentro da zona de silêncio.
       */
      it('o QR cabe na altura, com a folga de corte reservada', () => {
        const e = escalaDaPlaquinha(f, URL_TIPICA);
        const folga = f.recorteManual ? SEGURANCA_DE_CORTE_MM * 2 : 1;
        const margemInterna = f.midia === 'rolo' ? f.marginTopMm * 2 : 0;
        expect(e.qrMm).toBeLessThanOrEqual(f.heightMm - folga - margemInterna + 0.01);
      });

      it('sobra largura para o número da plaquinha', () => {
        // O #000N é o resgate humano de quando o QR não lê. Se o QR tomar a
        // largura inteira, o adesivo vira um quadrado ilegível.
        const e = escalaDaPlaquinha(f, URL_TIPICA);
        expect(e.qrMm).toBeLessThan(f.widthMm * 0.5);
      });

      /**
       * O piso vale para os formatos A4, que a rodada desenhou. O ROLO é a
       * geometria que a oficina já imprime hoje e é apertada de fato: 20 mm
       * para o símbolo deixam o módulo abaixo do piso. Não se esconde — o
       * sistema levanta a bandeira, e é isso que este caso cobra.
       */
      it('o módulo respeita o piso, ou a bandeira é levantada', () => {
        const e = escalaDaPlaquinha(f, URL_TIPICA);
        if (f.midia === 'folha') {
          expect(e.moduloMm).toBeGreaterThanOrEqual(MODULO_MINIMO_MM);
          expect(e.abaixoDoPiso).toBe(false);
        } else {
          expect(e.abaixoDoPiso).toBe(e.moduloMm < MODULO_MINIMO_MM);
        }
      });

      it('folha para recortar tem vão para a tesoura', () => {
        if (!f.recorteManual) return;
        // Vão zero é geometria de folha die-cut, onde o corte já veio de
        // fábrica. Para tesoura, a linha de corte cairia na fronteira entre
        // duas células — e o erro de ±1 mm da mão come a zona de silêncio.
        expect(f.gapXmm).toBeGreaterThanOrEqual(4);
        expect(f.gapYmm).toBeGreaterThanOrEqual(4);
      });
    });
  }
});

describe('a escala segue o QR de verdade, não um número assumido', () => {
  /**
   * A mesma plaquinha com um endereço mais longo sobe de versão, ganha módulos
   * e encolhe cada um deles. Assumir a contagem daria um número certo hoje e
   * errado no dia em que o endereço público mudasse — em silêncio, num adesivo
   * já colado.
   */
  it('endereço mais longo produz módulo menor', () => {
    const f = equipmentTagFormat('plaq_a4_63x33_3col');
    const curto = escalaDaPlaquinha(f, 'https://x.com/e/abc');
    const longo = escalaDaPlaquinha(f, 'https://um-dominio-bem-mais-longo.com.br/equipamento/' + 'z'.repeat(60));

    expect(longo.modulos).toBeGreaterThan(curto.modulos);
    expect(longo.moduloMm).toBeLessThan(curto.moduloMm);
  });

  it('endereço longo demais é sinalizado, não escondido', () => {
    const f = equipmentTagFormat('plaq_a4_63x33_3col');
    const absurdo = escalaDaPlaquinha(f, 'https://x.com/e/' + 'z'.repeat(1200));
    // Não recusa: gera e avisa. Quem imprime decide, sabendo.
    expect(absurdo.abaixoDoPiso).toBe(true);
  });
});

describe('a folha é desenhada em milímetro', () => {
  async function folhaDe(formatId: string) {
    const { ensureCoreSchema } = await import('../src/db/schema.js');
    const { resetDbForTests } = await import('../src/db/database.js');
    const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
    const { renderEquipmentTagSheet } = await import(
      '../src/services/core/EquipmentTagSheet.js'
    );

    resetDbForTests();
    ensureCoreSchema();
    const empresa = upsertCompany({
      slug: 'pj-motors',
      legalName: 'PJ Motors Ltda',
      tradeName: 'PJ Motors',
      kind: 'store',
    });

    return renderEquipmentTagSheet({
      companyId: empresa,
      format: equipmentTagFormat(formatId),
      items: [
        { publicIdLabel: '#0007', brand: 'Honda', model: 'CG 160 Titan', qrUrl: URL_TIPICA },
        { publicIdLabel: '#0008', brand: 'Shineray', model: 'Patinete X', qrUrl: URL_TIPICA },
      ],
    });
  }

  it('a página e a célula saem em mm, nunca em pixel', async () => {
    const f = await folhaDe('plaq_a4_63x33_3col');
    expect(f.html).toContain('@page { size: 210mm 297mm; margin: 0; }');
    expect(f.html).toContain('width: 63mm');
    // Pixel na folha é o defeito que a rodada corrige: a tela desenhava assim.
    expect(f.html).not.toMatch(/font-size:\s*\d+px/);
  });

  /**
   * O BLOQUEIO que três críticos apontaram: herdando a casca da etiqueta de
   * produto, a célula viria `flex-direction: column`. Empilhado, o QR ocupa a
   * altura inteira de 25 mm e o `#000N` sai do papel — cortado por overflow,
   * sem nada avisando.
   */
  it('a célula é uma LINHA, não uma coluna', async () => {
    const f = await folhaDe('plaq_a4_63x33_3col');
    expect(f.html).toContain('flex-direction: row');
    expect(f.html).not.toContain('flex-direction: column');
  });

  it('o nome da operação sai do cadastro, e não de um literal', async () => {
    const f = await folhaDe('plaq_a4_63x33_3col');
    expect(f.html).toContain('PJ Motors');
    // A tela cravava isto num sistema com seis operações.
    expect(f.html).not.toContain('GRUPO SAMPAIO · Oficina');
  });

  it('em rolo a margem é interna à etiqueta', async () => {
    // `recuoDaFolhaMm` devolve zero para rolo de propósito — quem aplica a
    // margem é a célula. Sem isto, a plaquinha de rolo sairia colada na borda.
    const f = await folhaDe('plaq_rolo_50x25');
    expect(f.html).toContain('padding: 2mm 2mm');
  });

  it('folha para recortar imprime o fio de corte', async () => {
    const f = await folhaDe('plaq_a4_63x33_3col');
    expect(f.html).toContain('dashed');
  });

  it('conta as folhas para a tela avisar antes de gastar adesivo', async () => {
    const f = await folhaDe('plaq_a4_63x33_3col');
    expect(f.folhas).toBe(1);
    expect(f.qrMm).toBeGreaterThan(0);
    expect(f.abaixoDoPiso).toBe(false);
  });
});
