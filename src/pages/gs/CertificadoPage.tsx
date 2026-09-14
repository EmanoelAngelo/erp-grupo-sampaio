/**
 * Configurações › Fiscal › Certificado digital.
 *
 * Uma operação por vez — o certificado é da empresa, e cada uma das seis tem o
 * seu. Sem certificado carregado, aquela operação simplesmente não emite nota.
 *
 * O QUE ESTA TELA NÃO FAZ, DE PROPÓSITO:
 *   - não guarda a senha em lugar nenhum (nem em estado que sobreviva ao envio);
 *   - não mostra o arquivo, a chave privada nem nada que aponte para o segredo;
 *   - não diz "homologado". Certificado carregado é certificado carregado;
 *     homologar exige teste real contra a SEFAZ.
 *
 * O arquivo é lido no navegador e enviado em base64 por HTTPS; quem cifra e
 * guarda é o cofre do backend.
 *
 * ## O QUE MUDOU NA RODADA DA AUTODETECÇÃO
 *
 * A tela pedia "CNPJ esperado (opcional)" — um campo que pedia à pessoa o
 * número que o próprio arquivo carrega, e que, deixado vazio (o caminho
 * normal), deixava passar o A1 de outra empresa em silêncio. O campo saiu: o
 * servidor confere SEMPRE, contra o CNPJ do emitente que a operação já tem
 * configurado, e o resultado aparece no cartão. Se o sistema descobre, ele não
 * pergunta.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, DataTable, Input, PageHeader } from '@/components/gs/ui';
import { CertificadoValidadoCard } from '@/components/gs/CertificadoValidado';
import { PoliticaDosAtosFiscaisCard } from '@/components/gs/PoliticaDosAtosFiscais';
import { formatarDocumento } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type CertificateView,
  type GroupCertificateItem,
  type SefazStatusView,
} from '@/lib/api/core';
import { dataBR } from '@/lib/datas';

const SITUATION_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  nao_configurado: 'neutral',
  valido: 'success',
  proximo_do_vencimento: 'warning',
  vencido: 'danger',
};

const SITUATION_LABEL: Record<string, string> = {
  nao_configurado: 'NÃO CONFIGURADO',
  valido: 'VÁLIDO',
  proximo_do_vencimento: 'PRÓXIMO DO VENCIMENTO',
  vencido: 'VENCIDO',
};

export default function CertificadoPage() {
  const [view, setView] = useState<CertificateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setView(await coreApi.getCertificate());
    } catch (err) {
      setView(null);
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao consultar o certificado.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AppShell>
      <PageHeader
        title="Certificado digital"
        subtitle="Certificado A1 da operação selecionada. Sem ele, esta operação não emite nota fiscal."
      />

      {message && (
        <div
          role="status"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]"
        >
          {message}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Situação" subtitle="Trocar a operação no topo mostra o certificado dela.">
          {view === null ? (
            <p role="status" className="text-[var(--gs-muted)]">
              {error ? 'Não foi possível consultar.' : 'Carregando…'}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {/* O cartão inteiro — tudo saído do próprio arquivo. */}
              {view.certificate ? (
                <CertificadoValidadoCard view={view} />
              ) : (
                <Badge tone={SITUATION_TONE[view.situation] ?? 'neutral'}>
                  {SITUATION_LABEL[view.situation] ?? view.situation}
                </Badge>
              )}

              <p className="text-[length:var(--gs-text-base)]">{view.message}</p>

              {/* O estado de prontidão fiscal vem do servidor e nunca diz
                  "homologado" só porque o arquivo foi carregado. */}
              <p className="text-[length:var(--gs-text-xs)] font-semibold uppercase tracking-wide text-[var(--gs-text-soft)]">
                Emissão fiscal: {view.readiness}
                {view.readiness === 'CERTIFICATE_LOADED' && ' · falta teste real contra a SEFAZ'}
              </p>

              {view.configured && <TesteDaSefaz />}

              {view.configured && (
                <RevogarBloco
                  onDone={(texto) => {
                    setMessage(texto);
                    void load();
                  }}
                  onError={setError}
                />
              )}
            </div>
          )}
        </Card>

        <UploadCard
          temCertificado={view?.configured === true}
          onDone={(texto) => {
            setMessage(texto);
            void load();
          }}
        />
      </div>

      <div className="mt-6">
        <PoliticaDosAtosFiscaisCard />
      </div>

      <div className="mt-6">
        <CertificadosDoGrupo />
      </div>
    </AppShell>
  );
}

/**
 * OS CERTIFICADOS DAS OPERAÇÕES DO GRUPO — GAP-V41.
 *
 * Conferir a situação dos seis A1 exigia trocar de operação seis vezes, e a
 * troca recarrega a página inteira. Na prática ninguém conferia: o vencimento
 * chegava e a emissão parava.
 *
 * QUEM APARECE É QUEM TEM VÍNCULO, não quem tem perfil. Quem administra uma
 * loja só vê uma linha — e isso não é um recorte da tela: é o servidor
 * respondendo pelo `core_user_companies`, a mesma régua da troca de operação.
 * Por isso o cartão não promete "as seis": ele mostra as suas.
 */
function CertificadosDoGrupo() {
  const [itens, setItens] = useState<GroupCertificateItem[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setItens(await coreApi.listGroupCertificates());
      } catch (err) {
        setErro(
          err instanceof ApiRequestError ? err.message : 'Falha ao listar os certificados.',
        );
      }
    })();
  }, []);

  // Sem senha selada também pede atenção: o arquivo não assina sozinho (GAP-PRD-023).
  const emAlerta = (itens ?? []).filter(
    (i) => i.alerta !== null || !i.configured || !i.senhaGuardada,
  );

  return (
    <Card
      title="Certificados das suas operações"
      subtitle={
        itens
          ? `${itens.length} operação(ões) com vínculo · ${emAlerta.length} precisam de atenção`
          : 'Carregando…'
      }
      padded={false}
    >
      {erro && (
        <p
          role="alert"
          className="px-4 py-3 m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
        >
          {erro}
        </p>
      )}

      {itens && (
        <DataTable
          rows={itens}
          keyOf={(i) => i.companyId}
          columns={[
            {
              header: 'Operação',
              render: (i) => (
                <div className="flex flex-col">
                  <span className="font-semibold text-[var(--gs-purple-900)]">{i.tradeName}</span>
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    {i.legalName}
                  </span>
                </div>
              ),
            },
            {
              header: 'Titular',
              render: (i) => (
                <div className="flex flex-col">
                  <span>{i.holderName ?? '—'}</span>
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    {i.documentNumber ? formatarDocumento(i.documentNumber) : '—'}
                  </span>
                </div>
              ),
            },
            { header: 'Emissor', render: (i) => i.issuer ?? '—' },
            { header: 'Válido até', render: (i) => dataBR(i.validTo) },
            {
              header: 'Dias',
              align: 'right',
              render: (i) => (
                <span className="tabular-nums">
                  {i.daysRemaining === null ? '—' : i.daysRemaining}
                </span>
              ),
            },
            {
              header: 'Situação',
              render: (i) => (
                <Badge tone={SITUATION_TONE[i.situation] ?? 'neutral'}>
                  {SITUATION_LABEL[i.situation] ?? i.situation}
                </Badge>
              ),
            },
            {
              /*
                GAP-PRD-023: a operação com o A1 gravado antes de a senha ser
                selada aparecia igual às outras — "válido" — e parava na primeira
                venda. Um booleano, nunca a senha.
              */
              header: 'Senha no cofre',
              render: (i) =>
                !i.configured ? (
                  '—'
                ) : i.senhaGuardada ? (
                  'selada'
                ) : (
                  <Badge tone="warning">NÃO SELADA — REENVIE</Badge>
                ),
            },
          ]}
        />
      )}

      {/*
        O segredo NÃO aparece aqui, e a linha abaixo diz isso em voz alta: o
        que a lista mostra é o que qualquer um lê abrindo o certificado. A
        senha só é representada por um "sim/não" no cartão da operação.
      */}
      <p className="px-4 py-3 m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
        Aparecem as operações em que você tem vínculo. Trocar a operação no topo abre o cartão
        completo e o envio do arquivo daquela empresa.
      </p>
    </Card>
  );
}

function UploadCard({
  temCertificado,
  onDone,
}: {
  temCertificado: boolean;
  onDone: (message: string) => void;
}) {
  const [fileName, setFileName] = useState('');
  const [pfxBase64, setPfxBase64] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A senha some da memória quando a tela sai de cena.
  useEffect(() => () => setPassword(''), []);

  const onFile = useCallback((file: File | null) => {
    setError(null);
    if (!file) {
      setFileName('');
      setPfxBase64('');
      return;
    }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      // `result` vem como data URL; só o base8 depois da vírgula interessa.
      const result = String(reader.result ?? '');
      setPfxBase64(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => setError('Não foi possível ler o arquivo.');
    reader.readAsDataURL(file);
  }, []);

  const enviar = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      /*
        SEM `expectedCnpj`, e isso é o conserto do GAP-V39.

        O campo pedia à pessoa o CNPJ que o arquivo carrega, e vazio — o
        caminho normal — desligava a conferência inteira. O servidor agora
        confere sempre, contra o CNPJ do emitente que esta operação já tem
        configurado, e devolve o veredito no cartão.
      */
      await coreApi.uploadCertificate({ pfxBase64, certificatePassword: password });
      // A senha é descartada assim que o envio termina.
      setPassword('');
      setPfxBase64('');
      setFileName('');
      onDone(
        temCertificado
          ? 'Certificado substituído. O anterior deixou de ser usado.'
          : 'Certificado carregado. Esta operação já pode assinar documentos fiscais.',
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar o certificado.');
    } finally {
      setBusy(false);
    }
  }, [pfxBase64, password, temCertificado, onDone]);

  return (
    <Card
      title={temCertificado ? 'Substituir certificado' : 'Carregar certificado'}
      subtitle="Arquivo .pfx ou .p12 e a senha. Nem o arquivo nem a senha ficam no navegador."
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Arquivo do certificado
          </span>
          <input
            type="file"
            accept=".pfx,.p12,application/x-pkcs12"
            onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            className="text-[length:var(--gs-text-sm)] file:mr-3 file:px-4 file:py-2 file:rounded-[var(--gs-radius)]
              file:border-0 file:bg-[var(--gs-purple-100)] file:text-[var(--gs-purple-800)]
              file:font-semibold file:cursor-pointer"
          />
          {fileName && (
            <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">{fileName}</span>
          )}
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Senha do certificado
          </span>
          <Input
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {error}
          </p>
        )}

        {/*
          NÃO HÁ MAIS CAMPO DE CNPJ, e a ausência é a melhoria. O arquivo diz
          titular, CNPJ, emissor, série e validade; pedir qualquer um desses é
          pedir transcrição, e transcrição erra. A conferência contra o CNPJ do
          emitente virou automática e obrigatória.
        */}
        <p className="text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
          O certificado é validado no envio: senha, janela de validade, assinatura e o CNPJ
          conferido contra o emitente desta operação. Se qualquer um falhar, nada é gravado.
          Titular, CNPJ, emissor e validade são lidos do próprio arquivo — não há o que digitar.
        </p>

        <Button loading={busy} disabled={!pfxBase64 || !password} onClick={() => void enviar()}>
          {temCertificado ? 'Substituir' : 'Carregar'}
        </Button>
      </div>
    </Card>
  );
}

/**
 * O TESTE DE COMUNICAÇÃO COM A SEFAZ — rodada 58.
 *
 * ## O que esta caixa responde, e por que ela existe
 *
 * Quem acaba de subir o certificado tem uma pergunta só: "isto funciona?".
 * O sistema não sabia responder — `statusServico` existia nos adapters,
 * falava SOAP de verdade com o webservice do estado, e ninguém o chamava.
 * A linha logo acima desta caixa dizia `CERTIFICATE_LOADED · falta teste real
 * contra a SEFAZ`, cobrando um teste que a tela não oferecia.
 *
 * Quatro coisas se provam de uma vez, sem criar documento nem gastar
 * numeração: a senha abre o arquivo, o TLS fecha com a chave, a SEFAZ do
 * estado está no ar, e a cadeia do certificado é aceita por ela.
 *
 * ## A senha não fica
 *
 * Ela é digitada a cada teste e some do estado assim que a resposta chega.
 * É a mesma decisão do envio do certificado: senha de A1 não mora no
 * navegador, não mora no cofre, e não vira "lembrar de mim".
 */
function TesteDaSefaz() {
  const [senha, setSenha] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [resposta, setResposta] = useState<SefazStatusView | null>(null);
  const [falha, setFalha] = useState<string | null>(null);

  const testar = async () => {
    setOcupado(true);
    setFalha(null);
    setResposta(null);
    try {
      setResposta(await coreApi.testSefazStatus(senha));
    } catch (err) {
      setFalha(
        err instanceof ApiRequestError ? err.message : 'Não foi possível testar agora.',
      );
    } finally {
      // A senha sai do estado com resposta ou sem ela.
      setSenha('');
      setOcupado(false);
    }
  };

  return (
    <div className="border-t border-[var(--gs-border)] pt-4 mt-2">
      <p className="m-0 font-semibold text-[length:var(--gs-text-base)]">
        Testar comunicação com a SEFAZ
      </p>
      <p className="m-0 mt-1 mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
        Pergunta ao fisco do seu estado se o serviço está no ar, usando este certificado.
        Não emite nota, não gasta numeração e não grava nada na SEFAZ.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void testar();
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Senha do certificado
          </span>
          <Input
            type="password"
            autoComplete="off"
            aria-label="Senha do certificado"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
          />
          <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
            Pedida a cada teste — ela não fica guardada.
          </span>
        </label>
        <Button type="submit" loading={ocupado} disabled={!senha}>
          Testar
        </Button>
      </form>

      {falha && (
        <p
          role="alert"
          className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
        >
          {falha}
        </p>
      )}

      {resposta && (
        <div
          role="status"
          className={`mt-3 px-4 py-3 rounded-[var(--gs-radius)] ${
            resposta.online
              ? 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]'
              : 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]'
          }`}
        >
          {/*
            A frase segue o que o FISCO disse, não uma conclusão nossa. O
            adapter real chamava cStat 108 — "Serviço Paralisado
            Momentaneamente" — de serviço no ar, e esta caixa pintava verde
            escrevendo "em operação" enquanto a SEFAZ dizia o contrário. O
            conserto foi na fonte (uma tabela só decide o que é "no ar"), e a
            tela deixa claro que a resposta CHEGOU nos dois casos — o
            certificado e a conexão funcionaram; quem está parado é o fisco.
          */}
          <p className="m-0 font-semibold">
            {resposta.online
              ? `SEFAZ-${resposta.uf} respondeu: serviço em operação.`
              : `SEFAZ-${resposta.uf} respondeu, mas o serviço está fora do ar agora.`}
          </p>
          {/*
            O motivo vem com as palavras do FISCO e chega inteiro: quando não é
            107, é essa frase que diz o que houve. O código fica junto para
            quem for procurar no manual.
          */}
          <p className="m-0 mt-1 text-[length:var(--gs-text-sm)]">
            {resposta.xMotivo ?? 'sem motivo declarado'}
            {resposta.cStat ? ` (cStat ${resposta.cStat})` : ''}
          </p>
          <p className="m-0 mt-1 text-[length:var(--gs-text-sm)]">
            Ambiente: {resposta.environment === 'production' ? 'produção' : 'homologação'} ·
            certificado de {resposta.certificate.subject}
          </p>
          {/*
            O ARQUIVO INCOMPLETO É INVISÍVEL SEM ISTO. Um .pfx da ICP-Brasil
            traz a folha e a autoridade que a emitiu; quando traz só a folha, a
            SEFAZ pode recusar o handshake por mais certo que o nosso lado
            esteja — e o conserto é do lado de fora, no site da AC. Sem o
            número, ninguém distingue "o sistema está errado" de "o arquivo
            está incompleto", e a pessoa procura no lugar errado.
          */}
          {resposta.certificate.chainLength <= 1 && (
            <p className="m-0 mt-2 text-[length:var(--gs-text-sm)]">
              <strong>Atenção:</strong> este arquivo tem só o certificado da empresa, sem as
              autoridades que o emitiram. Se a SEFAZ recusar a conexão, peça à sua certificadora
              o arquivo com a cadeia completa.
            </p>
          )}
          {/*
            O que este teste PROVA e o que ele NÃO prova. A parte que interessa
            vale nos DOIS casos: o certificado abriu e a conexão fechou —
            senão não haveria resposta nenhuma para ler. Mostrar isso só no
            verde escondia a melhor notícia justamente de quem topou com o
            fisco parado e ficaria sem saber se o problema era dele.
          */}
          <p className="m-0 mt-2 text-[length:var(--gs-text-sm)]">
            O certificado abriu e a conexão com a SEFAZ funcionou
            {resposta.online ? '' : ' — a indisponibilidade é do fisco, não da sua configuração'}
            . Emitir ainda depende do cadastro completo: a tela de configuração fiscal lista o
            que falta.
          </p>
        </div>
      )}
    </div>
  );
}

function RevogarBloco({
  onDone,
  onError,
}: {
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const revogar = useCallback(async () => {
    setBusy(true);
    try {
      await coreApi.revokeCertificate(reason);
      setAberto(false);
      setReason('');
      onDone('Certificado desativado. Esta operação parou de emitir nota.');
    } catch (err) {
      onError(err instanceof ApiRequestError ? err.message : 'Falha ao desativar.');
    } finally {
      setBusy(false);
    }
  }, [reason, onDone, onError]);

  if (!aberto) {
    return (
      <div className="pt-2 border-t border-[var(--gs-border)]">
        <Button variant="ghost" onClick={() => setAberto(true)}>
          Desativar certificado
        </Button>
      </div>
    );
  }

  return (
    <div className="pt-3 border-t border-[var(--gs-border)] flex flex-col gap-3">
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)] font-semibold">
        Desativar interrompe a emissão de nota nesta operação. O arquivo e a senha selada saem
        do cofre; o histórico de quem assinou os documentos anteriores é preservado.
      </p>
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Motivo da desativação"
      />
      <div className="flex gap-3 justify-end">
        <Button variant="ghost" onClick={() => setAberto(false)}>
          Voltar
        </Button>
        <Button loading={busy} disabled={!reason.trim()} onClick={() => void revogar()}>
          Confirmar desativação
        </Button>
      </div>
    </div>
  );
}
