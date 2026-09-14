/**
 * ============================================================================
 * O CARTÃO "CERTIFICADO VALIDADO"
 * ============================================================================
 *
 * A REGRA MESTRE: se o sistema descobre, ele não pergunta.
 *
 * Um `.pfx` da ICP-Brasil carrega titular, CNPJ, autoridade emissora, número
 * de série, janela de validade e a cadeia inteira. Tudo isso era lido no
 * envio e jogado fora — e a tela pedia "CNPJ esperado" para conferir um número
 * que o próprio arquivo já dizia. Este cartão mostra o que o arquivo informou,
 * e é por isso que o formulário de envio encolheu para arquivo + senha.
 *
 * O QUE NÃO ENTRA AQUI, e nunca vai entrar: o `.pfx`, a chave privada e a
 * senha. O que chega do servidor já vem sanitizado; este componente não tem
 * como mostrá-los porque não os recebe.
 *
 * A impressão digital SHA-256 fica visível de propósito: é como o dono
 * confirma que o arquivo instalado é o mesmo que ele tem em mãos, sem que o
 * servidor precise devolver nada do arquivo.
 */
import { Badge } from '@/components/gs/ui';
import { formatarDocumento } from '@/components/gs/format';
import type { CertificateAlert, CertificateCard, CertificateView } from '@/lib/api/core';
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

const TOM_DO_ALERTA: Record<CertificateAlert['severity'], string> = {
  info: 'bg-[var(--gs-info-bg)] text-[var(--gs-info)]',
  warning: 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]',
  danger: 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]',
};

/**
 * A faixa de vencimento como banner — GAP-V40.
 *
 * Aparece em três telas (painel, configuração fiscal e certificado) e é o
 * mesmo componente nas três: um aviso que muda de palavra conforme a tela
 * viraria três verdades sobre o mesmo certificado.
 *
 * Sem alerta, não renderiza NADA. Banner que aparece todo dia deixa de ser
 * lido, e aí o de sete dias antes do vencimento também passa despercebido.
 */
export function AvisoDeVencimento({ alerta }: { alerta: CertificateAlert | null | undefined }) {
  if (!alerta) return null;
  return (
    <div
      role={alerta.severity === 'danger' ? 'alert' : 'status'}
      className={`px-4 py-3 rounded-[var(--gs-radius)] ${TOM_DO_ALERTA[alerta.severity]}`}
    >
      <p className="m-0 font-semibold">{alerta.message}</p>
      <p className="m-0 mt-1 text-[length:var(--gs-text-sm)]">
        {alerta.band === 0
          ? 'Substitua o certificado em Fiscal › Certificado digital para voltar a emitir.'
          : 'A renovação é feita na sua certificadora e leva alguns dias — a emissão para no dia '
            + 'do vencimento, sem aviso na hora da venda.'}
      </p>
    </div>
  );
}

function Campo({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="rounded-[var(--gs-radius)] bg-[var(--gs-canvas)] px-4 py-3">
      <dt className="text-[length:var(--gs-text-xs)] font-semibold uppercase tracking-wide text-[var(--gs-text-soft)]">
        {rotulo}
      </dt>
      <dd className="font-bold text-[var(--gs-purple-900)] break-words">{valor}</dd>
    </div>
  );
}

/** O veredito da conferência do CNPJ (GAP-V39), quando há o que dizer. */
function ConferenciaDoCnpj({ cert }: { cert: CertificateCard }) {
  if (cert.cnpjConference === 'conferido') {
    return (
      <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-success)] font-semibold">
        CNPJ conferido contra o emitente desta operação.
      </p>
    );
  }
  if (!cert.cnpjConferenceWarning) return null;
  return (
    <p
      role="status"
      className="m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
        text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]"
    >
      {cert.cnpjConferenceWarning}
    </p>
  );
}

/**
 * O CERTIFICADO SEM A SENHA NO COFRE — GAP-PRD-023.
 *
 * Certificado gravado antes de a senha passar a ser selada tem o arquivo e não
 * tem a senha. O cartão dizia "Senha selada no cofre: não" dentro dos detalhes
 * técnicos, fechados — e o PDV parava em "senha necessária" sem que ninguém
 * tivesse sido instruído a fazer o reenvio. A instrução mora aqui, aberta: o
 * que para, e o gesto que resolve (a tela já tem o envio logo ao lado).
 *
 * `=== false`, e não "falsy": resposta sem o campo não é resposta de que falta
 * a senha, e acusar sem saber faria o dono reenviar à toa.
 */
function SenhaNaoSelada() {
  return (
    <div
      role="alert"
      className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]"
    >
      <p className="m-0 font-semibold">A senha deste certificado não está selada no cofre.</p>
      <p className="m-0 mt-1 text-[length:var(--gs-text-sm)]">
        Ele foi gravado antes de a senha passar a ser guardada. Enquanto isso, o PDV e a fila não
        assinam sozinhos — a emissão para em “senha necessária”, e cada cancelamento ou carta de
        correção pede a senha. Reenvie o mesmo arquivo .pfx com a senha em “Substituir
        certificado”: o reenvio sela a senha e preenche o titular e a conferência do CNPJ.
      </p>
    </div>
  );
}

/**
 * O cartão inteiro.
 *
 * `titulo` diz "CERTIFICADO VALIDADO" quando o arquivo passou por todas as
 * conferências do envio: senha que abre, janela de validade, CNPJ do emitente
 * e assinatura que fecha. Não é enfeite — é a diferença entre "tem arquivo" e
 * "tem arquivo que serve", e o sistema sabe qual das duas.
 */
export function CertificadoValidadoCard({ view }: { view: CertificateView }) {
  const cert = view.certificate;
  if (!cert) return null;

  // Sem a senha selada o arquivo existe mas não assina sozinho (GAP-PRD-023).
  const pendente =
    view.situation === 'vencido' || cert.selfSigned === true || cert.senhaGuardada === false;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Badge tone={pendente ? 'danger' : 'success'}>
          {pendente ? 'CERTIFICADO COM PENDÊNCIA' : 'CERTIFICADO VALIDADO'}
        </Badge>
        <Badge tone={SITUATION_TONE[view.situation] ?? 'neutral'}>
          {SITUATION_LABEL[view.situation] ?? view.situation}
        </Badge>
        {view.daysRemaining !== null && (
          <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] tabular-nums">
            {view.daysRemaining >= 0
              ? `${view.daysRemaining} dia(s) restantes`
              : `vencido há ${Math.abs(view.daysRemaining)} dia(s)`}
          </span>
        )}
      </div>

      <AvisoDeVencimento alerta={view.alerta} />

      {cert.senhaGuardada === false && <SenhaNaoSelada />}

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 m-0">
        {/* Tudo abaixo saiu do arquivo. Nenhum campo foi digitado. */}
        <Campo rotulo="Titular" valor={String(cert.holderName ?? cert.subject ?? '—')} />
        <Campo
          rotulo={cert.documentType === 'CPF' ? 'CPF do titular' : 'CNPJ do titular'}
          valor={formatarDocumento(cert.documentNumber ?? cert.cnpj)}
        />
        <Campo rotulo="Emissor (AC)" valor={String(cert.issuer ?? '—')} />
        <Campo rotulo="Número de série" valor={String(cert.serialNumber ?? '—')} />
        <Campo rotulo="Válido de" valor={dataBR(cert.validFrom ?? null)} />
        <Campo rotulo="Válido até" valor={dataBR(cert.validTo ?? null)} />
      </dl>

      <ConferenciaDoCnpj cert={cert} />

      {/*
        O ARQUIVO INCOMPLETO É INVISÍVEL SEM ISTO. Um .pfx da ICP-Brasil traz a
        folha e as autoridades que a emitiram; quando traz só a folha, a SEFAZ
        pode recusar o handshake por mais certo que o nosso lado esteja — e o
        conserto é do lado de fora, no site da certificadora.
      */}
      {cert.chainLength === 1 && (
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
          Este arquivo tem só o certificado da empresa, sem as autoridades que o emitiram. Se a
          SEFAZ recusar a conexão, peça à sua certificadora o arquivo com a cadeia completa.
        </p>
      )}

      {cert.selfSigned === true && (
        <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
          O certificado é autoassinado (o emissor é o próprio titular). Serve para teste local; a
          SEFAZ só aceita cadeia ICP-Brasil.
        </p>
      )}

      <details className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
        <summary className="cursor-pointer font-semibold">Detalhes técnicos do arquivo</summary>
        <dl className="grid grid-cols-1 gap-3 mt-3 m-0">
          <Campo rotulo="Titular (DN completo)" valor={String(cert.subjectDn ?? '—')} />
          <Campo rotulo="Emissor (DN completo)" valor={String(cert.issuerDn ?? '—')} />
          {/*
            A impressão digital identifica o ARQUIVO sem revelar nada dele: é
            como o dono confere que o que está no servidor é o mesmo `.pfx` que
            ele guardou.
          */}
          <Campo rotulo="Impressão digital (SHA-256)" valor={String(cert.fingerprintSha256 ?? '—')} />
          <Campo
            rotulo="Certificados no arquivo"
            valor={cert.chainLength == null ? '—' : String(cert.chainLength)}
          />
          <Campo
            rotulo="Senha selada no cofre"
            valor={
              cert.senhaGuardada
                ? 'sim — a emissão não pede senha a cada venda'
                : 'não — reenvie o arquivo com a senha'
            }
          />
        </dl>
      </details>
    </div>
  );
}
