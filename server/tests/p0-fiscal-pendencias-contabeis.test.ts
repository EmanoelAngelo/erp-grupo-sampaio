/**
 * P0 FISCAL — AS PENDÊNCIAS CONTÁBEIS, POR EMPRESA.
 *
 * O que o contador não informou não é inventado: ou a emissão recusa, ou o
 * padrão sai declarado — e esta lista junta tudo, por empresa, para a reunião
 * com o contador.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { upsertTaxGroup } from '../src/services/core/CatalogAuxService.js';
import { gravarOperacao } from '../src/services/core/FiscalOperacoes.js';
import { gravarPoliticaDeContingencia } from '../src/services/core/FiscalContingenciaOffline.js';
import { itemDePendenciasContabeis, pendenciasContabeis } from '../src/services/core/PendenciasContabeis.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

let empresa: string;

beforeEach(() => {
  resetDbForTests();
  empresa = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  updateFiscalConfig({
    companyId: empresa,
    patch: { legalName: 'Preço Justo Comércio Ltda', cnpj: '11.222.333/0001-81', crt: '1', uf: 'RS' },
  });
  grupoTributarioPadrao(empresa);
});

const chaves = (companyId: string) => pendenciasContabeis(companyId).map((p) => p.chave);

describe('o que depende do contador aparece — sem valor inventado', () => {
  it('a operação recém-implantada lista CST 49, DIFAL, contingência, devoluções e prazos', () => {
    const lista = chaves(empresa);
    expect(lista).toContain('grupo:SIMPLES-102:cst49');
    expect(lista).toContain('difal');
    expect(lista).toContain('st-ipi-beneficio');
    expect(lista).toContain('contingencia');
    expect(lista.some((c) => c.startsWith('operacao:devolucao_venda'))).toBe(true);
    expect(lista.some((c) => c.startsWith('operacao:devolucao_compra'))).toBe(true);
    expect(lista.some((c) => c.startsWith('operacao:venda_nfce'))).toBe(true);
    const devolucao = pendenciasContabeis(empresa).find((p) => p.chave === 'operacao:devolucao_venda:0')!;
    expect(devolucao.impede).toBe('producao');
  });

  it('CSOSN 101 sem pCredSN é pendência que IMPEDE a emissão; com ele, vira revisão periódica', () => {
    const grupo = upsertTaxGroup(empresa, {
      code: 'SIMPLES-101',
      name: '101',
      regime: 'simples',
      csosn: '101',
      cstPis: '49',
      cstCofins: '49',
    });
    const semPercentual = pendenciasContabeis(empresa).find((p) => p.chave === 'grupo:SIMPLES-101:pcredsn')!;
    expect(semPercentual.impede).toBe('emissao');
    expect(semPercentual.descricao).toMatch(/pCredSN/);

    // O contador informou: o MESMO grupo ganha o percentual (edição, não grupo novo).
    upsertTaxGroup(empresa, {
      id: grupo.id,
      code: 'SIMPLES-101',
      name: '101',
      regime: 'simples',
      csosn: '101',
      pCredSn: '1.25',
      cstPis: '49',
      cstCofins: '49',
    });
    const lista = chaves(empresa);
    expect(lista).not.toContain('grupo:SIMPLES-101:pcredsn');
    expect(lista).toContain('grupo:SIMPLES-101:pcredsn-revisao');
  });

  it('o que o contador confirma sai da lista — e só na empresa dele', () => {
    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
    for (const operacao of ['devolucao_venda', 'devolucao_compra'] as const) {
      gravarOperacao({ companyId: empresa, operacao, confirmadaPeloContador: true, grupoTributario: 'SIMPLES-102' });
    }
    for (const operacao of ['venda_nfce', 'venda_nfe'] as const) {
      gravarOperacao({ companyId: empresa, operacao, confirmadaPeloContador: true, prazoCancelamentoMinutos: 30 });
    }
    gravarPoliticaDeContingencia({ companyId: empresa, modo: 'OFFLINE_NFCE', prazoHoras: 24, userId: 'dono' });

    const lista = chaves(empresa);
    expect(lista.some((c) => c.startsWith('operacao:'))).toBe(false);
    expect(lista).not.toContain('contingencia');
    // A outra operação continua com as dela.
    expect(chaves(outra).some((c) => c.startsWith('operacao:devolucao_venda'))).toBe(true);
    expect(chaves(outra)).toContain('contingencia');
  });

  /*
    O PRODUTO SEM PERFIL TAMBÉM TEM GRUPO — e a exceção dele precisa aparecer.

    A contagem das exceções casava o grupo SÓ pelo `tax_profile`. O produto sem
    perfil — o caso normal da Preço Justo, com um único grupo ativo — nunca
    casava: o catálogo inteiro podia estar com CFOP próprio divergente e a
    lista dizia que não havia exceção nenhuma. A regra do grupo que vale para o
    produto é a da EMISSÃO: o grupo do perfil, ou o grupo único da operação.
  */
  it('exceção de CFOP aparece também no produto SEM perfil, pelo grupo único da operação', () => {
    expect(chaves(empresa)).not.toContain('produtos:cfop-proprio');

    // Sem perfil: vale o grupo único (SIMPLES-102, CFOP 5102/6102).
    createProduct(empresa, { name: 'Caneta com CFOP próprio', unit: 'UN', priceCents: 500, cfop: '5405' });
    const excecao = pendenciasContabeis(empresa).find((p) => p.chave === 'produtos:cfop-proprio')!;
    expect(excecao).toBeTruthy();
    expect(excecao.descricao).toMatch(/^1 produto\(s\) têm CFOP próprio/);

    // O CFOP igual ao do grupo não é exceção: não há o que confirmar.
    createProduct(empresa, { name: 'Caneta comum', unit: 'UN', priceCents: 500, cfop: '5102' });
    expect(
      pendenciasContabeis(empresa).find((p) => p.chave === 'produtos:cfop-proprio')!.descricao,
    ).toMatch(/^1 produto\(s\) têm CFOP próprio/);

    // E o produto COM perfil continua contando pelo grupo do perfil dele.
    createProduct(empresa, {
      name: 'Caneta do perfil',
      unit: 'UN',
      priceCents: 500,
      cfop: '5405',
      taxProfile: 'SIMPLES-102',
    });
    expect(
      pendenciasContabeis(empresa).find((p) => p.chave === 'produtos:cfop-proprio')!.descricao,
    ).toMatch(/^2 produto\(s\) têm CFOP próprio/);
  });

  it('o item do checklist informa (PENDING, dono contador) e nunca bloqueia a emissão', () => {
    const item = itemDePendenciasContabeis(empresa);
    expect(item).toMatchObject({ key: 'accountant_pending', status: 'PENDING', owner: 'contador', state: 'PENDENTE' });
    expect(item.detail).toMatch(/dependem do contador/);
    // Mesmo com o 101 sem pCredSN (que impede a emissão), o item não vira FAIL:
    // essa falta já é FAIL no item da tributação, com o produto nomeado.
    upsertTaxGroup(empresa, { code: 'SIMPLES-101', name: '101', regime: 'simples', csosn: '101', cstPis: '49', cstCofins: '49' });
    expect(itemDePendenciasContabeis(empresa).status).not.toBe('FAIL');
  });
});
