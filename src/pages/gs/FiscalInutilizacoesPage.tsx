/**
 * Fiscal › Inutilizações.
 *
 * Tela própria, e não uma ação escondida no menu de um documento: inutilizar
 * não age sobre uma nota — age sobre NUMERAÇÃO QUE NUNCA VIROU NOTA. Colocar
 * junto das ações de documento confundiria as duas coisas.
 *
 * É a operação mais irreversível da área fiscal: depois dela, aqueles números
 * não saem mais. Por isso a confirmação é explícita e diz exatamente isso.
 */
import { useCallback, useEffect, useState } from 'react';
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
import { CaminhoDoAtoFiscal } from '@/components/gs/CaminhoDoAtoFiscal';
import { podeEnviarAtoFiscal, usePlanoDoAtoFiscal } from '@/components/gs/planoDoAtoFiscal';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type FiscalVoidRange } from '@/lib/api/core';
import { dataHoraBR } from '@/lib/datas';

const STATUS_TOM: Record<FiscalVoidRange['status'], 'success' | 'danger' | 'warning'> = {
  AUTHORIZED: 'success',
  REJECTED: 'danger',
  REQUESTED: 'warning',
};

const STATUS_ROTULO: Record<FiscalVoidRange['status'], string> = {
  AUTHORIZED: 'Inutilizada',
  REJECTED: 'Recusada',
  REQUESTED: 'Aguardando resposta',
};

const dataHora = dataHoraBR;

export default function FiscalInutilizacoesPage() {
  const [itens, setItens] = useState<FiscalVoidRange[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setItens(await coreApi.listVoidRanges());
    } catch (err) {
      setItens(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Fiscal', 'Inutilizações']}
        title="Inutilização de numeração"
        actions={<Button onClick={() => setCriando(true)}>Nova inutilização</Button>}
      />

      {aviso && (
        <p
          role="status"
          className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)]
            text-[length:var(--gs-text-sm)] text-[var(--gs-success)]"
        >
          {aviso}
        </p>
      )}
      {erro && (
        <p
          role="alert"
          className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
            text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
        >
          {erro}
        </p>
      )}

      {criando && (
        <div className="mb-5">
          <NovaInutilizacao
            onCancelar={() => setCriando(false)}
            onErro={setErro}
            onConcluido={async (mensagem) => {
              setCriando(false);
              setAviso(mensagem);
              await carregar();
            }}
          />
        </div>
      )}

      <Card
        title="Faixas"
        subtitle="Numeração inutilizada não volta a ser emitida em nenhuma hipótese."
      >
        {itens && (
          <DataTable
            rows={itens}
            keyOf={(v) => v.id}
            empty={
              <EmptyState
                title="Nenhuma inutilização"
                description="Nenhuma faixa de numeração foi inutilizada nesta operação."
              />
            }
            columns={[
              { header: 'Data', render: (v) => dataHora(v.createdAt) },
              {
                header: 'Modelo / Série',
                render: (v) => `${v.model === '65' ? 'NFC-e' : 'NF-e'} · série ${v.serie}`,
              },
              {
                header: 'Faixa',
                render: (v) => (
                  <span className="font-semibold tabular-nums">
                    {v.from} a {v.to}
                  </span>
                ),
              },
              {
                header: 'Situação',
                render: (v) => (
                  <div className="flex flex-col gap-1 items-start">
                    <Badge tone={STATUS_TOM[v.status]}>{STATUS_ROTULO[v.status]}</Badge>
                    {v.cStat && (
                      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        cStat {v.cStat}
                      </span>
                    )}
                  </div>
                ),
              },
              {
                header: 'Protocolo',
                render: (v) => (
                  <span className="text-[length:var(--gs-text-sm)] font-mono break-all">
                    {v.protocol ?? '—'}
                  </span>
                ),
              },
              {
                header: 'Justificativa',
                render: (v) => (
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                    {v.justification ?? '—'}
                  </span>
                ),
              },
            ]}
          />
        )}
      </Card>
    </AppShell>
  );
}

/**
 * Formulário e confirmação.
 *
 * A confirmação não é decorativa: ela existe porque o efeito é permanente e
 * não há como desfazer pela interface nem pelo fisco.
 */
function NovaInutilizacao({
  onCancelar,
  onConcluido,
  onErro,
}: {
  onCancelar: () => void;
  onConcluido: (mensagem: string) => Promise<void>;
  onErro: (mensagem: string) => void;
}) {
  const [form, setForm] = useState({
    model: '55',
    serie: '1',
    year: String(new Date().getFullYear()),
    from: '',
    to: '',
    justification: '',
  });
  const [confirmando, setConfirmando] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erroLocal, setErroLocal] = useState<string | null>(null);
  // Inutilização não age sobre nota: o plano é o da operação (SEFAZ, com o A1
  // do cofre ou a senha digitada — GAP-PRD-005).
  const [senha, setSenha] = useState('');
  const plano = usePlanoDoAtoFiscal(null);
  const podeEnviar = podeEnviarAtoFiscal(plano, senha);

  const set = (chave: keyof typeof form) => (valor: string) =>
    setForm((atual) => ({ ...atual, [chave]: valor }));

  const de = Number(form.from);
  const ate = Number(form.to);
  const quantidade = Number.isFinite(de) && Number.isFinite(ate) && ate >= de ? ate - de + 1 : 0;

  const enviar = useCallback(async () => {
    setBusy(true);
    setErroLocal(null);
    try {
      const r = await coreApi.createVoidRange({
        model: form.model,
        serie: Number(form.serie),
        year: Number(form.year),
        from: de,
        to: ate,
        justification: form.justification,
        certificatePassword: senha || undefined,
      });

      // Recusa do fisco NÃO é erro do sistema: a faixa continua disponível, e
      // o operador precisa ler o motivo.
      await onConcluido(
        r.accepted
          ? `Faixa ${de} a ${ate} inutilizada. Protocolo ${r.protocol}.`
          : `A SEFAZ recusou a inutilização${r.cStat ? ` (cStat ${r.cStat})` : ''}: ${r.xMotivo ?? 'sem motivo informado'}.`,
      );
    } catch (err) {
      const mensagem = err instanceof ApiRequestError ? err.message : 'Falha ao inutilizar.';
      setErroLocal(mensagem);
      onErro(mensagem);
      setConfirmando(false);
    } finally {
      setBusy(false);
    }
  }, [form, de, ate, senha, onConcluido, onErro]);

  if (confirmando) {
    return (
      <Card title="Confirmar inutilização" subtitle="Esta ação não pode ser desfeita.">
        <div className="flex flex-col gap-4">
          <div
            role="alert"
            className="px-4 py-3 rounded-[var(--gs-radius)] border-2 border-[var(--gs-danger)]
              bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
          >
            <strong className="block text-[length:var(--gs-text-base)]">
              Os números {de} a {ate} nunca mais poderão ser usados.
            </strong>
            <span className="text-[length:var(--gs-text-sm)]">
              São {quantidade} número(s) da série {form.serie}, modelo{' '}
              {form.model === '65' ? 'NFC-e' : 'NF-e'}. Nenhuma emissão futura vai reutilizá-los,
              nem no sistema nem perante o fisco.
            </span>
          </div>

          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] m-0">
            Justificativa: {form.justification}
          </p>

          {plano.plano && (
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] m-0">
              {plano.plano.motivo}
            </p>
          )}

          {erroLocal && (
            <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
              {erroLocal}
            </p>
          )}

          <div className="flex gap-3">
            <Button loading={busy} disabled={!podeEnviar} onClick={() => void enviar()}>
              Confirmar e inutilizar
            </Button>
            <Button variant="ghost" onClick={() => setConfirmando(false)}>
              Voltar
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Nova inutilização"
      subtitle="Para numeração que foi reservada e não virou nota — falha de sistema, queda no meio da emissão."
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Modelo" required>
            {(p) => (
              <select
                {...p}
                value={form.model}
                onChange={(e) => set('model')(e.target.value)}
                className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                  bg-[var(--gs-surface)] text-[length:var(--gs-text-base)] text-[var(--gs-text)]"
              >
                <option value="55">NF-e (55)</option>
                <option value="65">NFC-e (65)</option>
              </select>
            )}
          </Field>
          <Field label="Série" required>
            {(p) => (
              <Input {...p} value={form.serie} onChange={(e) => set('serie')(e.target.value)} />
            )}
          </Field>
          <Field label="Ano" required>
            {(p) => (
              <Input {...p} value={form.year} onChange={(e) => set('year')(e.target.value)} />
            )}
          </Field>
          <Field label="Número inicial" required>
            {(p) => (
              <Input
                {...p}
                value={form.from}
                onChange={(e) => set('from')(e.target.value)}
                inputMode="numeric"
              />
            )}
          </Field>
          <Field label="Número final" required>
            {(p) => (
              <Input
                {...p}
                value={form.to}
                onChange={(e) => set('to')(e.target.value)}
                inputMode="numeric"
              />
            )}
          </Field>
          <Field label="Quantidade" hint="Calculada a partir da faixa.">
            {(p) => (
              <p
                {...p}
                className="h-11 flex items-center px-3 rounded-[var(--gs-radius)]
                  bg-[var(--gs-surface-hover)] text-[length:var(--gs-text-base)] m-0"
              >
                {quantidade > 0 ? `${quantidade} número(s)` : '—'}
              </p>
            )}
          </Field>
        </div>

        <Field
          label="Justificativa"
          required
          hint="Mínimo de 15 caracteres — é o que explica a operação a quem auditar depois."
        >
          {(p) => (
            <Input
              {...p}
              value={form.justification}
              onChange={(e) => set('justification')(e.target.value)}
            />
          )}
        </Field>

        <CaminhoDoAtoFiscal estado={plano} senha={senha} onSenha={setSenha} />

        <div className="flex gap-3">
          <Button
            disabled={quantidade <= 0 || form.justification.trim().length < 15 || !podeEnviar}
            onClick={() => setConfirmando(true)}
          >
            Revisar e confirmar
          </Button>
          <Button variant="ghost" onClick={onCancelar}>
            Cancelar
          </Button>
        </div>
      </div>
    </Card>
  );
}
