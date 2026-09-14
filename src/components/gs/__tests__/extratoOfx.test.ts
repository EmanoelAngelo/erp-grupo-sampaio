/**
 * O EXTRATO EM OFX (GAP-V27).
 *
 * O que estes casos protegem, em ordem de custo do erro:
 *
 *   1. O VALOR. Ler `-45.90` como 4590 positivo transforma tarifa em
 *      recebimento e o total do banco fecha para o lado errado.
 *   2. A DATA. `20260831120000[-3:BRT]` é o dia 31 — virar 30 por causa de
 *      fuso é a armadilha que esta casa já pisou duas vezes.
 *   3. O FITID. É o que faz reimportar o arquivo do mês não duplicar o mês; se
 *      ele não sair daqui, o dedupe do servidor não tem por onde pegar.
 */
import { describe, expect, it } from 'vitest';
import { lerArquivoDeExtrato, parseExtratoOfx, pareceOfx } from '../extratoOfx';

/** Um OFX 1.x (SGML) como o internet banking brasileiro exporta. */
const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>BRL
<BANKACCTFROM><BANKID>001<ACCTID>12345-6<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260801
<DTEND>20260831
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260810120000[-3:BRT]
<TRNAMT>150.00
<FITID>2026081000001
<MEMO>PIX RECEBIDO FULANO
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260831
<TRNAMT>-45.90
<FITID>2026083100007
<MEMO>TARIFA MENSALIDADE
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

/** OFX 2.x é XML: as tags de folha fecham. O leitor precisa aceitar os dois. */
const OFX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OFX>
  <BANKMSGSRSV1><STMTTRNRS><STMTRS>
    <BANKTRANLIST>
      <STMTTRN>
        <TRNTYPE>CREDIT</TRNTYPE>
        <DTPOSTED>20260815</DTPOSTED>
        <TRNAMT>1234.56</TRNAMT>
        <FITID>ABC-999</FITID>
        <NAME>DEPOSITO</NAME>
      </STMTTRN>
    </BANKTRANLIST>
  </STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

describe('o valor sai com sinal, em centavos inteiros', () => {
  it('crédito e débito do mesmo arquivo', () => {
    const { linhas, erros } = parseExtratoOfx(OFX_SGML);
    expect(erros).toBe(0);
    expect(linhas).toHaveLength(2);
    expect(linhas[0].amountCents).toBe(15_000);
    // Sem o sinal, uma tarifa entraria como recebimento e o total do banco
    // fecharia R$ 91,80 acima do que caiu na conta.
    expect(linhas[1].amountCents).toBe(-4_590);
  });

  it('centavo não vira arredondamento', () => {
    const { linhas } = parseExtratoOfx(
      '<STMTTRN><DTPOSTED>20260801<TRNAMT>0.01<FITID>x<MEMO>Ajuste</STMTTRN>',
    );
    expect(linhas[0].amountCents).toBe(1);
  });
});

describe('a data é o DIA, não um instante', () => {
  it('a hora e o fuso do DTPOSTED não movem o dia', () => {
    // '20260831120000[-3:BRT]' é 31/08. Converter para instante e formatar
    // noutro fuso devolveria 30/08 — o defeito que já mordeu duas vezes aqui.
    const { linhas } = parseExtratoOfx(OFX_SGML);
    expect(linhas[0].occurredAt).toBe('2026-08-10');
    expect(linhas[1].occurredAt).toBe('2026-08-31');
  });

  it('data impossível é recusada em vez de virar linha torta', () => {
    const { linhas, erros } = parseExtratoOfx(
      '<STMTTRN><DTPOSTED>20261301<TRNAMT>10.00<FITID>x</STMTTRN>',
    );
    expect(linhas).toHaveLength(0);
    expect(erros).toBe(1);
  });
});

describe('o FITID viaja — é ele que impede o mês duplicado', () => {
  it('cada lançamento leva a identidade que o banco deu', () => {
    const { linhas } = parseExtratoOfx(OFX_SGML);
    expect(linhas[0].externalId).toBe('2026081000001');
    expect(linhas[1].externalId).toBe('2026083100007');
  });
});

describe('OFX 2.x (XML) é lido pelo mesmo leitor', () => {
  it('tags fechadas não confundem o valor nem a descrição', () => {
    const { linhas, erros } = parseExtratoOfx(OFX_XML);
    expect(erros).toBe(0);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].amountCents).toBe(123_456);
    expect(linhas[0].occurredAt).toBe('2026-08-15');
    expect(linhas[0].externalId).toBe('ABC-999');
    // Sem MEMO, o NAME é o que existe — melhor do que "Sem descrição".
    expect(linhas[0].description).toBe('DEPOSITO');
  });
});

describe('lançamento ilegível conta como erro, e NÃO entra', () => {
  it('sem valor, a linha fica de fora e a tela sabe quantas ficaram', () => {
    // Importar 40 de 42 em silêncio é a forma mais cara de conciliar: a
    // diferença aparece no fim do mês como divergência sem causa.
    const { linhas, erros } = parseExtratoOfx(
      `<STMTTRN><DTPOSTED>20260801<TRNAMT>10.00<FITID>a<MEMO>Boa</STMTTRN>
       <STMTTRN><DTPOSTED>20260802<FITID>b<MEMO>Sem valor</STMTTRN>`,
    );
    expect(linhas).toHaveLength(1);
    expect(erros).toBe(1);
  });
});

describe('o formato é decidido pelo CONTEÚDO', () => {
  it('OFX é reconhecido mesmo com nome de arquivo qualquer', () => {
    expect(pareceOfx(OFX_SGML)).toBe(true);
    expect(lerArquivoDeExtrato(OFX_SGML).formato).toBe('ofx');
  });

  it('CSV colado continua sendo lido como CSV', () => {
    const lido = lerArquivoDeExtrato('31/08/2026;Recebimento;1.234,56');
    expect(lido.formato).toBe('csv');
    expect(lido.linhas[0].amountCents).toBe(123_456);
    // CSV não tem identidade do banco — e a tela precisa poder dizer isso.
    expect(lido.linhas[0].externalId ?? null).toBeNull();
  });
});
