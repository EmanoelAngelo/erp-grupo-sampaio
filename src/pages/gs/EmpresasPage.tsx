/**
 * ============================================================================
 * EMPRESAS DO GRUPO — a tela onde a sétima operação nasce
 * ============================================================================
 *
 * ## O que esta tela é
 *
 * A lista das operações que existem e o formulário que abre mais uma. É a
 * primeira tela do sistema que fala do GRUPO em vez de falar da empresa da
 * sessão: tudo o mais aqui dentro é escopado pelo tenant, e esta atravessa.
 *
 * ## QUEM CHEGA AQUI, e por que a resposta não é "o escritório"
 *
 * As duas rotas que ela consome (`GET`/`POST /core/companies`) são guardadas
 * no servidor por `requireProfile(req)` sem perfil extra — `admin_geral` e
 * `gestor`, e mais ninguém. O roteador declara `DONOS_DO_GRUPO` junto com o
 * ambiente, e o menu declara o mesmo: os três dizem a MESMA coisa, e
 * `menu-e-rotas.test.tsx` quebra no dia em que um deles mudar sozinho.
 *
 * Isto custou uma dimensão nova no roteador (perfil, ao lado de ambiente), que
 * até esta rodada não existia. A alternativa era pôr a tela em `ROTA_GESTAO` e
 * deixar o estoquista clicar num item que responde 403 — o desalinhamento
 * entre guarda e tela que já apareceu em três rodadas seguidas.
 *
 * ## A TELA DIZ O QUE VAI FAZER, ANTES DE FAZER
 *
 * Criar uma operação não é gravar um cadastro: é criar uma empresa, criar um
 * LOGIN novo com senha provisória e, quando é oficina, criar a primeira
 * bancada. Quem aperta o botão sai daqui com uma credencial na mão para
 * entregar a alguém — e precisa saber disso ANTES, não descobrir depois.
 *
 * Por isso o aviso é um bloco fixo acima do botão, e não um diálogo de
 * confirmação: diálogo aparece depois da decisão tomada e é clicado no
 * automático. E ele muda conforme o tipo escolhido, porque um aviso que
 * promete uma bancada numa criação de loja é falso.
 *
 * ## A SENHA APARECE UMA VEZ
 *
 * Ela não volta do servidor nunca — lá existe só o hash Argon2id. A única
 * cópia é a que a pessoa digitou, e esta tela a mostra uma vez, ao lado do
 * login, com a frase dizendo que não volta. Ao dispensar o quadro, a senha sai
 * do estado da tela e não há caminho de volta: nem recarregar, nem criar outra
 * empresa a traz.
 *
 * Não inventamos senha aqui. Quem digita é quem cria, do mesmo jeito que na
 * tela de equipe — duas formas de nascer credencial seriam duas verdades sobre
 * como uma senha provisória chega até a pessoa.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
} from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type Company, type CompanyCreated, type CompanyKind } from '@/lib/api/core';
import { empresaPlaquinhaApi } from '@/lib/api/empresaPlaquinha';
import { empresaTemPlaquinha } from '@/lib/acesso/plaquinhaDaEmpresa';
import { resumoDaImplantacao, type ResumoDaEmpresa } from '@/lib/api/implantacaoDasEmpresas';
import { SITUACAO_NA_TELA } from '@/pages/gs/implantacaoRotulos';

const TIPO_ROTULO: Record<string, string> = {
  retail: 'Loja',
  workshop: 'Oficina',
};

/** CNPJ legível. Formata o que tiver 14 dígitos; o resto sai como veio. */
function cnpjLegivel(cnpj: string | null): string {
  const digitos = (cnpj ?? '').replace(/\D/g, '');
  if (digitos.length !== 14) return cnpj || '—';
  return `${digitos.slice(0, 2)}.${digitos.slice(2, 5)}.${digitos.slice(5, 8)}/${digitos.slice(8, 12)}-${digitos.slice(12)}`;
}

export default function EmpresasPage() {
  const [empresas, setEmpresas] = useState<Company[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [erroDeLeitura, setErroDeLeitura] = useState<string | null>(null);
  /*
    A situação da implantação de cada empresa (GAP-PRD-067). Leitura à parte e
    sem alarme: se ela falhar, a lista continua e a coluna mostra só o caminho
    para o checklist — a lista de operações não pode depender do checklist.
  */
  const [implantacao, setImplantacao] = useState<Map<string, ResumoDaEmpresa>>(new Map());

  const [legalName, setLegalName] = useState('');
  const [tradeName, setTradeName] = useState('');
  const [cnpj, setCnpj] = useState('');
  const [kind, setKind] = useState<CompanyKind>('retail');
  /**
   * O tipo da primeira bancada, quando é oficina. O servidor sempre aceitou
   * `workshopKind` e a tela nunca mandava: toda oficina nascia mobilidade.
   */
  const [workshopKind, setWorkshopKind] = useState<'mobility' | 'phones'>('mobility');
  /*
    PLAQUINHA COM QR NA CRIAÇÃO — saiu (P0 das plaquinhas).

    A caixa "Esta operação usa plaquinha com QR" nascia marcada para oficina de
    mobilidade e deixava ligar em qualquer loja. Plaquinha é exclusiva da PJ
    Motors, e operação nova nunca é a PJ (o slug é único, e ela já existe): a
    caixa não tem o que oferecer, e o servidor recusaria com 403. A operação
    nasce sem plaquinha e o pedido não carrega o campo.
  */
  /** A empresa cuja marca de plaquinha está sendo trocada na lista. */
  const [trocandoPlaquinha, setTrocandoPlaquinha] = useState<string | null>(null);
  const [avisoPlaquinha, setAvisoPlaquinha] = useState<string | null>(null);
  const [erroPlaquinha, setErroPlaquinha] = useState<string | null>(null);
  const [gerenteNome, setGerenteNome] = useState('');
  const [gerenteLogin, setGerenteLogin] = useState('');
  const [gerenteEmail, setGerenteEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [salvando, setSalvando] = useState(false);

  /**
   * A credencial recém-criada, viva só nesta aba e só até ser dispensada.
   *
   * Guarda a resposta do servidor E a senha digitada — a senha vem daqui
   * porque a resposta não a traz. Nada disto vai para `localStorage`: uma
   * senha provisória sobrevivendo ao fechamento da aba é uma senha esquecida
   * num navegador compartilhado do escritório.
   */
  const [credencial, setCredencial] = useState<{
    criado: CompanyCreated;
    senhaDigitada: string;
  } | null>(null);

  const carregar = useCallback(async () => {
    setErroDeLeitura(null);
    try {
      setEmpresas(await coreApi.listCompanies());
    } catch (err) {
      // Nulo, e não lista vazia: "não pude ler" e "o grupo não tem operação"
      // são fatos diferentes e não podem exibir a mesma coisa.
      setEmpresas(null);
      setErroDeLeitura(
        err instanceof ApiRequestError && err.status === 403
          ? 'Só quem responde pelo grupo (administrador ou gestor) enxerga as operações.'
          : err instanceof ApiRequestError
            ? err.message
            : 'Falha ao carregar as operações do grupo.',
      );
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  useEffect(() => {
    // Só depois que a lista chegou: sem empresa na tela, não há onde pôr a situação.
    if (!empresas) return undefined;
    let vivo = true;
    resumoDaImplantacao()
      .then((itens) => {
        if (vivo) setImplantacao(new Map(itens.map((i) => [i.empresaId, i])));
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [empresas]);

  const criar = async () => {
    setErro(null);
    setSalvando(true);
    try {
      const criado = await coreApi.createCompany({
        legalName: legalName.trim(),
        tradeName: tradeName.trim() || undefined,
        cnpj: cnpj.trim() || null,
        kind,
        ...(kind === 'workshop' ? { workshopKind } : {}),
        manager: {
          login: gerenteLogin.trim(),
          displayName: gerenteNome.trim(),
          email: gerenteEmail.trim() || null,
          password: senha,
        },
      });

      setCredencial({ criado, senhaDigitada: senha });

      /*
        O formulário é esvaziado NA HORA, inclusive a senha.
        Deixá-lo preenchido convidaria ao segundo clique — que criaria uma
        segunda empresa quase idêntica, com um segundo login, e o servidor
        aceitaria: não há idempotência aqui, e nem deveria haver. Abrir a
        oitava operação é uma decisão nova, digitada do começo.
      */
      setLegalName('');
      setTradeName('');
      setCnpj('');
      setKind('retail');
      setWorkshopKind('mobility');
      setGerenteNome('');
      setGerenteLogin('');
      setGerenteEmail('');
      setSenha('');

      await carregar();
    } catch (err) {
      setErro(
        err instanceof ApiRequestError
          ? err.message
          : 'Falha ao abrir a operação. Nada foi criado.',
      );
    } finally {
      setSalvando(false);
    }
  };

  const podeCriar =
    legalName.trim().length > 0 &&
    gerenteNome.trim().length > 0 &&
    gerenteLogin.trim().length > 0 &&
    senha.length > 0 &&
    !salvando;

  const nomeDaOperacao = tradeName.trim() || legalName.trim() || 'a nova operação';

  /**
   * Liga ou desliga a plaquinha de uma operação que já existe (GAP-PRD-185).
   * Antes, só um UPDATE no banco fazia isso — a sétima oficina nascia sem.
   */
  const alternarPlaquinha = async (c: Company) => {
    setErroPlaquinha(null);
    setAvisoPlaquinha(null);
    setTrocandoPlaquinha(c.id);
    try {
      const r = await empresaPlaquinhaApi.definir(c.id, !c.usesEquipmentTags);
      setAvisoPlaquinha(
        r.usesEquipmentTags
          ? `${c.tradeName} passou a usar plaquinha com QR: o gerente já pode gerar o primeiro lote.`
          : `${c.tradeName} deixou de gerar plaquinhas. As já coladas continuam respondendo pelo QR.`,
      );
      await carregar();
    } catch (err) {
      setErroPlaquinha(
        err instanceof ApiRequestError ? err.message : 'Não foi possível mudar a plaquinha da operação.',
      );
    } finally {
      setTrocandoPlaquinha(null);
    }
  };

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Configurações', 'Empresas do grupo']}
        title="Empresas do grupo"
        subtitle="As operações que existem hoje, e a porta para abrir mais uma."
      />

      {erroDeLeitura && (
        <div
          role="alert"
          className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] border
            border-[var(--gs-danger)] bg-[var(--gs-danger-bg)]
            text-[var(--gs-danger)] text-[length:var(--gs-text-base)]"
        >
          {erroDeLeitura}
        </div>
      )}

      {avisoPlaquinha && (
        <p
          role="status"
          className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]"
        >
          {avisoPlaquinha}
        </p>
      )}

      {erroPlaquinha && (
        <div
          role="alert"
          className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] border
            border-[var(--gs-danger)] bg-[var(--gs-danger-bg)]
            text-[var(--gs-danger)] text-[length:var(--gs-text-base)]"
        >
          {erroPlaquinha}
        </div>
      )}

      {credencial && (
        <CredencialRecemCriada
          criado={credencial.criado}
          senha={credencial.senhaDigitada}
          onDispensar={() => setCredencial(null)}
        />
      )}

      <div className="flex flex-col gap-5">
        <Card
          title="Operações do grupo"
          subtitle="Cada linha é uma empresa com CNPJ, estoque, caixa e equipe próprios."
        >
          <DataTable
            rows={empresas ?? []}
            keyOf={(c) => c.id}
            empty={
              <EmptyState
                title={erroDeLeitura ? 'Lista não carregada' : 'Nenhuma operação'}
                description={
                  erroDeLeitura
                    ? 'A lista acima não pôde ser lida — a mensagem no topo diz por quê.'
                    : 'O grupo ainda não tem nenhuma empresa ativa.'
                }
              />
            }
            columns={[
              {
                header: 'Nome fantasia',
                render: (c) => (
                  <div className="flex flex-col">
                    <span className="font-semibold text-[var(--gs-purple-900)]">
                      {c.tradeName}
                    </span>
                    {/* O endereço da vitrine. Quem abriu a operação precisa
                        saber qual saiu, porque o servidor deriva do nome e
                        pode acrescentar sufixo para não colidir. */}
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      /{c.slug}
                    </span>
                  </div>
                ),
              },
              { header: 'Razão social', render: (c) => c.legalName },
              {
                header: 'Implantação',
                render: (c) => {
                  const r = implantacao.get(c.id);
                  return (
                    <Link
                      to={`/sistema/empresas/${c.id}/implantacao`}
                      className="inline-flex items-center gap-2 underline text-[var(--gs-purple-900)]"
                    >
                      {r ? <Badge tone={SITUACAO_NA_TELA[r.situacao].tom}>{SITUACAO_NA_TELA[r.situacao].rotulo}</Badge> : null}
                      Checklist
                    </Link>
                  );
                },
              },
              { header: 'CNPJ', render: (c) => cnpjLegivel(c.cnpj) },
              {
                header: 'Tipo',
                render: (c) => (
                  <Badge tone={c.kind === 'workshop' ? 'info' : 'neutral'}>
                    {TIPO_ROTULO[c.kind] ?? c.kind}
                  </Badge>
                ),
              },
              {
                /*
                  PLAQUINHA COM QR (GAP-PRD-185): a marca que decide se a
                  operação gera plaquinhas no pool do grupo. Era gravada só
                  pelo passo de migração, por slug.

                  Desde o P0 das plaquinhas o botão só existe na linha da PJ
                  Motors: ligar em outra operação é 403 no servidor, e botão
                  que sempre falha ensina a desconfiar da tela. As outras linhas
                  dizem de quem a plaquinha é. O selo mostra o valor EFETIVO
                  que o servidor manda (a marca velha da Oficina não aparece
                  como "Usa").
                */
                header: 'Plaquinha com QR',
                render: (c) => (
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={c.usesEquipmentTags ? 'success' : 'neutral'}>
                      {c.usesEquipmentTags ? 'Usa' : 'Não usa'}
                    </Badge>
                    {empresaTemPlaquinha(c.slug) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`${c.usesEquipmentTags ? 'Desligar' : 'Ligar'} plaquinha de ${c.tradeName}`}
                        loading={trocandoPlaquinha === c.id}
                        onClick={() => void alternarPlaquinha(c)}
                      >
                        {c.usesEquipmentTags ? 'Desligar' : 'Ligar'}
                      </Button>
                    ) : (
                      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        Exclusiva da PJ Motors
                      </span>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Card>

        <Card
          title="Abrir nova operação"
          subtitle="Empresa, primeiro gerente e — quando é oficina — a primeira bancada, tudo de uma vez."
        >
          <OQueVaiAcontecer
            kind={kind}
            nome={nomeDaOperacao}
            login={gerenteLogin.trim()}
          />

          {erro && (
            <div
              role="alert"
              className="mt-4 px-4 py-3 rounded-[var(--gs-radius)] border
                border-[var(--gs-danger)] bg-[var(--gs-danger-bg)]
                text-[var(--gs-danger)] text-[length:var(--gs-text-base)]"
            >
              {erro}
            </div>
          )}

          <form
            className="mt-5 flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (podeCriar) void criar();
            }}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Razão social" required hint="O nome do contrato social.">
                {(props) => (
                  <Input
                    {...props}
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                    placeholder="Sampaio Motos Peças e Serviços Ltda"
                  />
                )}
              </Field>

              <Field
                label="Nome fantasia"
                hint="Vira o endereço da vitrine. Em branco, repete a razão social."
              >
                {(props) => (
                  <Input
                    {...props}
                    value={tradeName}
                    onChange={(e) => setTradeName(e.target.value)}
                    placeholder="Sampaio Centro"
                  />
                )}
              </Field>

              <Field
                label="CNPJ"
                /*
                  A dica antiga dizia que sem este campo a operação não emite
                  nota. É falso: o emitente da NF-e mora em
                  `core_fiscal_configs.cnpj`, escrito pela tela Fiscal, e é
                  independente deste. Os únicos leitores de
                  `core_companies.cnpj` são o cabeçalho do cupom e o do A4.

                  Mandar alguém preencher aqui para "habilitar nota" faria a
                  pessoa acreditar que resolveu o fiscal, e descobrir o
                  contrário na primeira venda que precisasse de nota.
                */
                hint="Sai no cabeçalho do cupom e do A4. O CNPJ que emite nota fiscal é outro, e fica em Fiscal › Dados do emitente."
              >
                {(props) => (
                  <Input
                    {...props}
                    value={cnpj}
                    onChange={(e) => setCnpj(e.target.value)}
                    inputMode="numeric"
                    placeholder="00.000.000/0000-00"
                  />
                )}
              </Field>

              <Field
                label="Tipo de operação"
                required
                hint="Oficina nasce com a primeira bancada; loja, não."
              >
                {(props) => (
                  <select
                    {...props}
                    value={kind}
                    onChange={(e) => setKind(e.target.value as CompanyKind)}
                    className="h-10 px-3 rounded-[var(--gs-radius)] border
                      border-[var(--gs-border-strong)] bg-[var(--gs-surface)]
                      text-[var(--gs-text)] text-[length:var(--gs-text-base)]"
                  >
                    <option value="retail">Loja</option>
                    <option value="workshop">Oficina</option>
                  </select>
                )}
              </Field>

              {kind === 'workshop' && (
                <Field
                  label="Tipo da primeira bancada"
                  required
                  hint="Mobilidade (moto, bicicleta, patinete) ou celulares — decide peças e plaquinha."
                >
                  {(props) => (
                    <select
                      {...props}
                      value={workshopKind}
                      onChange={(e) => setWorkshopKind(e.target.value as 'mobility' | 'phones')}
                      className="h-10 px-3 rounded-[var(--gs-radius)] border
                        border-[var(--gs-border-strong)] bg-[var(--gs-surface)]
                        text-[var(--gs-text)] text-[length:var(--gs-text-base)]"
                    >
                      <option value="mobility">Mobilidade</option>
                      <option value="phones">Celulares</option>
                    </select>
                  )}
                </Field>
              )}
            </div>

            <div className="border-t border-[var(--gs-border)] pt-5">
              <h3 className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-purple-900)] m-0">
                Primeiro gerente
              </h3>
              <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-1 mb-4">
                Sem ele a empresa nasceria trancada: ninguém entraria nela para configurá-la. Por
                isso o cadastro é obrigatório aqui, e não numa segunda tela.
              </p>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Nome de quem vai gerenciar" required>
                  {(props) => (
                    <Input
                      {...props}
                      value={gerenteNome}
                      onChange={(e) => setGerenteNome(e.target.value)}
                      placeholder="Maria Sampaio"
                    />
                  )}
                </Field>

                <Field label="Login" required hint="Único no sistema inteiro, não só nesta empresa.">
                  {(props) => (
                    <Input
                      {...props}
                      value={gerenteLogin}
                      onChange={(e) => setGerenteLogin(e.target.value)}
                      autoComplete="off"
                      placeholder="maria.centro"
                    />
                  )}
                </Field>

                <Field label="E-mail" hint="Opcional. Usado para recuperação e avisos.">
                  {(props) => (
                    <Input
                      {...props}
                      type="email"
                      value={gerenteEmail}
                      onChange={(e) => setGerenteEmail(e.target.value)}
                      placeholder="maria@grupo.com.br"
                    />
                  )}
                </Field>

                <Field
                  label="Senha provisória"
                  required
                  hint="Você vai vê-la uma vez, ao criar. Ela não volta depois."
                >
                  {/*
                    Visível enquanto se digita, como na tela de equipe: esconder
                    atrás de asteriscos uma senha que será DITADA a outra
                    pessoa só produz erro de digitação numa credencial que
                    ninguém vai reaproveitar.
                  */}
                  {(props) => (
                    <Input
                      {...props}
                      value={senha}
                      onChange={(e) => setSenha(e.target.value)}
                      autoComplete="new-password"
                      placeholder="Mínimo de 8 caracteres"
                    />
                  )}
                </Field>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!podeCriar} loading={salvando}>
                Criar empresa e primeiro gerente
              </Button>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Tudo ou nada: se qualquer passo falhar, nada é criado.
              </span>
            </div>
          </form>
        </Card>
      </div>
    </AppShell>
  );
}

/**
 * O AVISO QUE VEM ANTES DO BOTÃO.
 *
 * Três frases porque são três coisas que passam a existir, e a do meio é a que
 * ninguém espera: um LOGIN novo, que quem clicou vai ter de entregar a alguém.
 *
 * O texto acompanha o tipo escolhido em vez de listar as duas hipóteses. Um
 * aviso que diz "e a primeira bancada, se for oficina" obriga quem lê a
 * resolver a condicional na cabeça — e um aviso que promete bancada numa
 * criação de loja mente. A frase muda; a promessa é sempre exata.
 */
function OQueVaiAcontecer({
  kind,
  nome,
  login,
}: {
  kind: CompanyKind;
  nome: string;
  login: string;
}) {
  return (
    <div
      className="rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
        bg-[var(--gs-surface-hover)] px-5 py-4"
    >
      <p className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-purple-900)] m-0">
        O que este botão faz
      </p>
      <ol className="mt-2 mb-0 pl-5 flex flex-col gap-1.5 text-[length:var(--gs-text-base)] text-[var(--gs-text-soft)]">
        <li>
          Cria a empresa <strong>{nome}</strong> como{' '}
          <strong>{kind === 'workshop' ? 'oficina' : 'loja'}</strong> do grupo, com CNPJ, estoque,
          caixa e equipe próprios.
        </li>
        <li>
          Cria o <strong>primeiro gerente</strong>
          {login ? (
            <>
              , com o login <strong>{login}</strong>
            </>
          ) : null}{' '}
          e a senha provisória que você digitar abaixo.{' '}
          <strong>Você sai desta tela com um login novo para entregar a alguém.</strong>
        </li>
        {kind === 'workshop' ? (
          <li>
            Cria a <strong>primeira bancada</strong> da oficina e já vincula o gerente a ela — sem
            bancada, um gerente de oficina entra e não vê ordem de serviço nenhuma.
          </li>
        ) : (
          <li>
            <strong>Não</strong> cria bancada: loja não tem oficina. Escolha “Oficina” no tipo se
            for esse o caso.
          </li>
        )}
        <li>
          <strong>Não</strong> usa plaquinha com QR: ela é exclusiva da PJ Motors. A mercadoria da
          operação nova é identificada pela etiqueta de produto.
        </li>
      </ol>
    </div>
  );
}

/**
 * A CREDENCIAL, MOSTRADA UMA VEZ.
 *
 * Fica no topo da página e não num diálogo: diálogo é fechado no reflexo, e
 * esta é a única aparição da senha em toda a vida do sistema. O botão que a
 * dispensa diz o que ele faz — "já anotei" —, porque um "×" no canto não avisa
 * que fechar é definitivo.
 *
 * A frase da troca no primeiro acesso vem de `manager.mustChangePassword`, que
 * é o que o SERVIDOR gravou, e não de uma constante escrita aqui. Se um dia
 * ele parar de exigir, a tela para de prometer — em vez de continuar afirmando
 * uma regra que deixou de existir.
 */
function CredencialRecemCriada({
  criado,
  senha,
  onDispensar,
}: {
  criado: CompanyCreated;
  senha: string;
  onDispensar: () => void;
}) {
  return (
    <section
      // `alert` porque isto é a única aparição da senha: o leitor de tela
      // precisa anunciá-la sem que a pessoa vá procurá-la.
      role="alert"
      className="mb-5 rounded-[var(--gs-radius)] border-2 border-[var(--gs-orange-500)]
        bg-[var(--gs-surface)] shadow-[var(--gs-shadow)] px-5 py-4"
    >
      <h2 className="text-[17px] font-semibold text-[var(--gs-purple-900)] m-0">
        {criado.company.tradeName} está no ar
      </h2>
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-1 mb-4">
        Endereço da operação: /{criado.company.slug}
        {criado.workshop ? ` · bancada criada: ${criado.workshop.name}` : ''}
        {criado.linkedGroupAdmins.length > 0
          ? ` · ${criado.linkedGroupAdmins.length} administrador(es) do grupo ganharam acesso`
          : ''}
      </p>

      <dl className="grid gap-3 sm:grid-cols-2 m-0">
        <div>
          <dt className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Login do gerente
          </dt>
          <dd className="m-0 text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] break-all">
            {criado.manager.login}
          </dd>
        </div>
        <div>
          <dt className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Senha provisória
          </dt>
          <dd className="m-0 text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] break-all">
            {senha}
          </dd>
        </div>
      </dl>

      <p className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-danger)] mt-4 mb-0">
        Anote agora: esta senha aparece uma única vez e não volta. O servidor guarda só o
        embaralhado dela — nem esta tela nem o suporte conseguem mostrá-la de novo.
      </p>
      {/*
        A frase antiga dizia que "o sistema vai exigir" a troca no primeiro
        acesso. Medido: NÃO exige. `must_change_password = 1` é gravado, o campo
        atravessa até aqui, e nenhum passo do login o consulta — entrar com a
        senha provisória devolve token completo e dá para vender no mesmo
        minuto. A bandeira é um lembrete para quem administra, não uma trava.

        Promessa que o sistema não cumpre é pior que ausência, e num aviso de
        senha é pior ainda: quem lê para de cobrar a troca, achando que o
        sistema cobra.
      */}
      {criado.manager.mustChangePassword && (
        <p className="text-[length:var(--gs-text-base)] text-[var(--gs-text-soft)] mt-2 mb-0">
          A conta está marcada como “senha provisória”, e isso aparece em Pessoas › Usuários e
          equipe. O sistema <strong>não</strong> força a troca no primeiro acesso: peça a{' '}
          {criado.manager.displayName} para trocá-la.
        </p>
      )}
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-2 mb-0">
        Perdida a senha, o caminho é resetá-la em Pessoas › Usuários e equipe — não há recuperação.
      </p>

      <div className="mt-4">
        <Button variant="secondary" onClick={onDispensar}>
          Já anotei, esconder a senha
        </Button>
      </div>
    </section>
  );
}
