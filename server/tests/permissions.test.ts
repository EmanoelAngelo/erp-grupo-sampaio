/**
 * O catálogo de permissões responde por todas as rotas que existem?
 *
 * ESTE ARQUIVO EXISTE POR UM DEFEITO QUE PASSOU DESPERCEBIDO POR MESES.
 *
 * `requirePermission` comparava a string da permissão com os CÓDIGOS DE PERFIL
 * do token. Nunca casava. 235 rotas em 18 roteadores respondiam só ao
 * `admin_geral`, e a suíte inteira passava verde — porque todo teste de rota
 * montava sessão de administrador.
 *
 * O teste de COBERTURA abaixo é o que não deixa isso voltar: ele lê as rotas
 * reais e cobra que todo módulo usado esteja declarado. Módulo esquecido falha
 * fechado, e falhar fechado em silêncio foi exatamente o problema.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MODULOS_DECLARADOS,
  acaoDe,
  ehLeitura,
  moduloDe,
  temPermissao,
} from '../src/services/auth/Permissions.js';
import { ASSIGNABLE_PROFILES } from '../src/services/core/TeamService.js';

/**
 * Apaga comentários de bloco e de linha antes de varrer, preservando o TAMANHO
 * do texto (troca por espaço) para que nada mais se cole por acidente.
 *
 * COMENTÁRIO NÃO É GUARDA, e ler prosa como código dá vermelho falso. Os
 * roteadores desta casa explicam as decisões por extenso, e as explicações
 * CITAM as chamadas ("o alcance deixa de ser `requireProfile(req,
 * 'gerente_loja')` e passa a ser o do escritório"). A varredura não-gulosa
 * colava a citação ao `);` de uma linha adiante e recolhia dali palavras que
 * nunca foram argumento de guarda nenhuma — no caso, `escritorio`, que é
 * AMBIENTE (de `abertaAo`) e não perfil. Um vermelho por comentário é o tipo
 * que ensina a ignorar o vermelho.
 */
function semComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** Todas as permissões realmente exigidas pelas rotas, lidas do código. */
function permissoesUsadasNasRotas(): string[] {
  const dir = join(process.cwd(), 'src', 'routes', 'v1');
  const encontradas = new Set<string>();
  for (const arquivo of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const texto = semComentarios(readFileSync(join(dir, arquivo), 'utf8'));
    for (const m of texto.matchAll(/requirePermission\('([^']+)'\)/g)) {
      encontradas.add(m[1]!);
    }
  }
  return [...encontradas].sort();
}

/**
 * O OUTRO mecanismo de autorização, que ninguém varria.
 *
 * `requirePermission` é o guarda dos 18 roteadores e tem o teste de cobertura
 * acima. Mas `core.ts` — o roteador com mais rotas do sistema — quase não usa
 * `requirePermission`: ele usa `requireProfile`, uma função local que compara
 * o código de perfil direto. São 224 chamadas, e nenhum teste as olhava.
 *
 * O que passou por essa fresta: `requireProfile(req, 'gerente_loja',
 * 'financeiro')` em três rotas e `'tecnico'` em duas. Nem `'financeiro'` nem
 * `'tecnico'` existem em `ASSIGNABLE_PROFILES`, e `TeamService` recusa
 * qualquer código fora dela — ninguém jamais pôde receber esses perfis.
 *
 * Não bloqueava nada, porque a concessão é aditiva e havia um perfil válido ao
 * lado. Mas o código AFIRMAVA um papel que não existia, e quem lesse contaria
 * duas portas onde havia uma. É a mesma classe do defeito que originou este
 * arquivo: autorização que parece existir e não existe.
 */
function perfisUsadosNasRotas(): string[] {
  const dir = join(process.cwd(), 'src', 'routes', 'v1');
  const encontrados = new Set<string>();

  for (const arquivo of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const texto = semComentarios(readFileSync(join(dir, arquivo), 'utf8'));

    // As listas nomeadas (CAIXAS, AUX_EDITORES...) entram por spread. Sem
    // resolvê-las, a varredura passaria por cima justamente das guardas
    // reaproveitadas — que são as que mais rotas protegem.
    const listas = new Map<string, string[]>();
    for (const m of texto.matchAll(/const\s+([A-Z_]+)\s*=\s*\[([^\]]*)\]\s*as const;/g)) {
      listas.set(m[1]!, [...m[2]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!));
    }

    // Não-guloso até o primeiro `);`: cobre a chamada de uma linha e a
    // quebrada em várias, que existem nas duas formas no arquivo.
    for (const chamada of texto.matchAll(/requireProfile\(\s*req\s*,([\s\S]*?)\);/g)) {
      const args = chamada[1]!;
      for (const lit of args.matchAll(/'([^']+)'/g)) encontrados.add(lit[1]!);
      for (const spread of args.matchAll(/\.\.\.([A-Z_]+)/g)) {
        for (const p of listas.get(spread[1]!) ?? []) encontrados.add(p);
      }
    }
  }
  return [...encontrados].sort();
}

/**
 * Os dois códigos que valem sem estar em `ASSIGNABLE_PROFILES`.
 *
 * `admin_geral` não é atribuível pela tela de equipe de propósito — é o dono
 * do sistema, não um cargo da loja. `operador_caixa` é o genérico de
 * instalação antiga, mantido porque ainda há usuário em campo com ele.
 */
const VALIDOS_FORA_DA_LISTA = ['admin_geral', 'operador_caixa'];

describe('cobertura do requireProfile', () => {
  it('a varredura encontra as guardas (senão este teste não prova nada)', () => {
    // Se um refactor mudar a forma da chamada, a regex para de casar e o teste
    // ficaria verde varrendo o vazio. Este caso é o que impede isso.
    expect(perfisUsadosNasRotas().length).toBeGreaterThan(5);
  });

  it('todo perfil exigido por uma rota pode de fato ser atribuído a alguém', () => {
    const permitidos = new Set<string>([...ASSIGNABLE_PROFILES, ...VALIDOS_FORA_DA_LISTA]);
    const fantasmas = perfisUsadosNasRotas().filter((p) => !permitidos.has(p));

    // Mensagem útil no vermelho: o conserto é criar o perfil OU tirar a string.
    expect(fantasmas.join(', ')).toBe('');
  });
});

describe('cobertura do catálogo', () => {
  it('as rotas realmente exigem permissão (senão este arquivo não prova nada)', () => {
    /*
      O piso prova que a varredura não roda sobre o vazio — não é meta de
      quantidade. Eram mais de cem; os roteadores /crm e /automations
      (GAP-PRD-075) levaram trinta rotas guardadas, e os fiscais legados
      (`/fiscal`, `/fiscal/nfe` e quase todo `/fiscal/nfce`, GAP-PRD-096)
      saíram com as ~40 chaves `fiscal.*` deles. Na junção do GAP-PRD-075, o
      roteador `/integrations` levou as seis `integrations.*` (de 53 para 47) e
      o CSC foi para o núcleo, onde a guarda é `requireProfile` — sai a
      `fiscal.nfce.csc.manage`. Quarenta continua impossível de alcançar com a
      regex quebrada.
    */
    expect(permissoesUsadasNasRotas().length).toBeGreaterThan(40);
  });

  /**
   * O teste que pega o defeito original.
   *
   * Módulo não declarado nega — então uma permissão de módulo desconhecido é
   * uma rota que ninguém alcança. Se alguém criar `relatorios.x.view` sem
   * declarar `relatorios`, isto cai aqui e não em produção.
   */
  it('toda permissão usada pertence a um módulo declarado', () => {
    const orfas = permissoesUsadasNasRotas().filter(
      (p) => !MODULOS_DECLARADOS.includes(moduloDe(p)),
    );
    expect(orfas).toEqual([]);
  });

  it('nenhuma permissão usada é negada para o gestor', () => {
    const negadas = permissoesUsadasNasRotas().filter((p) => !temPermissao(['gestor'], p));
    expect(negadas).toEqual([]);
  });
});

describe('quem responde por tudo', () => {
  it('admin_geral passa em qualquer permissão', () => {
    expect(temPermissao(['admin_geral'], 'fiscal.nfe.authorize')).toBe(true);
    expect(temPermissao(['admin_geral'], 'system-recovery.manage')).toBe(true);
  });

  /**
   * A unificação: `requireProfile` (core.ts:378) já deixava o gestor passar em
   * tudo, e `requirePermission` não. O mesmo usuário fazia tudo no core e nada
   * nos outros 18 roteadores.
   */
  it('gestor passa em qualquer permissão, como já passava no core', () => {
    expect(temPermissao(['gestor'], 'fiscal.nfe.authorize')).toBe(true);
    expect(temPermissao(['gestor'], 'automation.rule.create')).toBe(true);
  });

  it('sem perfil nenhum, nada passa', () => {
    expect(temPermissao([], 'fiscal.nfe.view')).toBe(false);
    expect(temPermissao([], 'workshop.order.view')).toBe(false);
  });
});

describe('falha fechada', () => {
  it('módulo não declarado nega, mesmo para ação de leitura', () => {
    expect(temPermissao(['gerente_loja'], 'inventado.coisa.view')).toBe(false);
    expect(temPermissao(['mecanico'], 'inventado.coisa.manage')).toBe(false);
  });

  it('mas continua liberando para quem responde por tudo', () => {
    expect(temPermissao(['admin_geral'], 'inventado.coisa.manage')).toBe(true);
  });
});

describe('leitura e escrita', () => {
  it('reconhece as ações que só olham', () => {
    expect(ehLeitura('fiscal.nfe.view')).toBe(true);
    expect(ehLeitura('asaas.queue.status')).toBe(true);
    expect(ehLeitura('fiscal.nfe.authorize')).toBe(false);
    expect(ehLeitura('automation.rule.create')).toBe(false);
  });

  it('a ação é o último segmento, não o do meio', () => {
    expect(acaoDe('asaas.charge.create')).toBe('create');
    expect(moduloDe('asaas.charge.create')).toBe('asaas');
    expect(moduloDe('payment-terminal.charge.create')).toBe('payment-terminal');
  });

  /**
   * Quem escreve também lê — senão cada módulo repetiria a lista duas vezes.
   *
   * O par usado aqui era `mecanico` × `workshop`, e o módulo `workshop` saiu da
   * matriz na rodada 36 junto com o roteador legado que era o único a pedi-lo.
   * A PROPRIEDADE continua valendo e continua merecendo teste, então o caso
   * mudou de par em vez de ser apagado: `estoquista` está em `escrever` de
   * `logistics` e NÃO está em `ler`, que é exatamente a forma de que o teste
   * precisa — a segunda linha só passa por causa da regra que ela cobra. Um par
   * cujo perfil estivesse nas duas listas passaria sem provar nada.
   */
  it('quem escreve num módulo também consulta', () => {
    expect(temPermissao(['estoquista'], 'logistics.shipment.manage')).toBe(true);
    expect(temPermissao(['estoquista'], 'logistics.shipment.view')).toBe(true);
  });

  /*
    O par era `estoquista` × `fiscal`, e o módulo `fiscal` saiu da matriz na F1
    do RBAC granular: nenhuma rota viva pedia `requirePermission('fiscal.*')`
    (o fiscal do núcleo guarda por `requireProfile`). A propriedade continua
    merecendo teste, com um módulo vivo: `atendente` está em `ler` de `asaas`
    e fora de `escrever`.
  */
  it('quem só lê não escreve', () => {
    expect(temPermissao(['atendente'], 'asaas.queue.view')).toBe(true);
    expect(temPermissao(['atendente'], 'asaas.charge.create')).toBe(false);
  });
});

describe('a matriz sem módulo morto, e o catálogo novo ao lado', () => {
  /*
    Os módulos `fiscal`, `crm` e `corporate-bi` não tinham rota viva que os
    pedisse — eram alcance prometido que ninguém conferia. A regra da matriz é
    falhar fechada, não prometer: saíram. Módulo usado por rota continua
    coberto pelo caso "toda permissão usada pertence a um módulo declarado".
  */
  it('fiscal, crm e corporate-bi saíram', () => {
    for (const morto of ['fiscal', 'crm', 'corporate-bi']) expect(MODULOS_DECLARADOS).not.toContain(morto);
  });

  it('Permissions.ts reexporta o catálogo de capabilities (a fonte única do RBAC granular)', async () => {
    const permissoes = await import('../src/services/auth/Permissions.js');
    expect(permissoes.CATALOGO.length).toBe(141);
    expect(typeof permissoes.ehCapability).toBe('function');
  });
});

describe('os casos concretos do balcão', () => {
  /**
   * O caixa COBRA na maquininha. Sem escrita em payment-terminal, o PDV não
   * fecha venda em cartão — que é o caminho mais usado do balcão.
   */
  it('o operador de caixa cobra na maquininha', () => {
    for (const perfil of ['operador_caixa_loja', 'operador_caixa_oficina', 'operador_caixa']) {
      expect(temPermissao([perfil], 'payment-terminal.charge.create')).toBe(true);
    }
  });

  it('o operador de caixa NÃO ativa produção do provedor de pagamento', () => {
    expect(temPermissao(['operador_caixa_loja'], 'asaas.production.activate')).toBe(false);
  });

  /*
    APAGADO NA RODADA 36: `o mecânico move a OS`.

    O caso cobrava `temPermissao(['mecanico'], 'workshop.order.manage')`, e o
    módulo `workshop` desta matriz só era pedido pelo roteador `/api/v1/workshop`
    legado — apagado na mesma rodada por não ter chamador nem uma linha em
    nenhuma das suas vinte e uma tabelas. Ou seja: ele provava o acesso do
    mecânico a rotas que ninguém chamava.

    A promessa em si NÃO se perdeu, porque nunca morou aqui. Quem move a OS de
    verdade é `POST /core/workshop/orders/:id/move`, que guarda com
    `requireProfile(req, 'mecanico', 'gerente_oficina', 'operador_caixa_oficina')`
    — outro mecanismo, que não passa por esta matriz. E ela é cobrada pela rota,
    com sessão de mecânico de verdade, em `workshops-equipment.test.ts`.
  */

  it('o mecânico não mexe no fiscal nem no BI', () => {
    expect(temPermissao(['mecanico'], 'fiscal.nfe.authorize')).toBe(false);
    expect(temPermissao(['mecanico'], 'corporate-bi.report.view')).toBe(false);
  });

  it('o estoquista cuida da logística e não da promoção', () => {
    expect(temPermissao(['estoquista'], 'logistics.shipment.manage')).toBe(true);
    expect(temPermissao(['estoquista'], 'promotion.rule.manage')).toBe(false);
  });

  /** Credencial de terceiro e recuperação de sistema são só da gestão. */
  it('nenhum perfil de operação toca em integrações, automação ou recuperação', () => {
    for (const perfil of ['gerente_loja', 'gerente_oficina', 'mecanico', 'operador_caixa_loja']) {
      expect(temPermissao([perfil], 'integrations.credential.manage')).toBe(false);
      expect(temPermissao([perfil], 'automation.rule.create')).toBe(false);
      expect(temPermissao([perfil], 'system-recovery.manage')).toBe(false);
    }
  });
});
