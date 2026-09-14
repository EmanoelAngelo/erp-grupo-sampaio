/**
 * A NFS-e DA OFICINA — configuração e prontidão (GAP-PRD-024).
 *
 * O modo é decisão do DONO, com padrão seguro (desligada: nada sai por
 * engano). Os códigos são do CONTADOR — o sistema não chuta nenhum. A
 * confirmação de que o município está no Sistema Nacional é da PREFEITURA.
 * Cada pendência do checklist diz de quem é.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Field, Input } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  nfseApi,
  ROTULO_DO_MODO_DA_NFSE,
  type ConfiguracaoDaNfse,
  type DonoDaPendencia,
  type ModoDaNfse,
  type PatchDaNfse,
  type ProntidaoDaNfse,
} from '@/lib/api/nfse';

const DONO_ROTULO: Record<DonoDaPendencia, string> = {
  dono: 'Dono',
  gerente: 'Gerência',
  contador: 'Contador',
  prefeitura: 'Prefeitura',
};

const SIMPLES: Record<string, string> = {
  '1': 'Não optante',
  '2': 'MEI',
  '3': 'ME/EPP (Simples Nacional)',
};

const REGIME_SN: Record<string, string> = {
  '1': 'Federais e ISS pelo Simples',
  '2': 'Federais pelo Simples, ISS fora',
  '3': 'Federais e ISS fora do Simples',
};

const RETENCAO: Record<string, string> = {
  '1': 'Não retido',
  '2': 'Retido pelo tomador',
  '3': 'Retido pelo intermediário',
};

const REGIME_ESPECIAL: Record<string, string> = {
  '0': 'Nenhum',
  '1': 'Ato cooperado',
  '2': 'Estimativa',
  '3': 'Microempresa municipal',
  '4': 'Notário ou registrador',
  '5': 'Profissional autônomo',
  '6': 'Sociedade de profissionais',
};

interface Rascunho {
  mode: ModoDaNfse;
  serviceCode: string;
  municipalServiceCode: string;
  nbsCode: string;
  serviceDescription: string;
  issRate: string;
  simplesOption: string;
  simplesRegime: string;
  specialRegime: string;
  issWithholding: string;
  dpsSeries: string;
  nextDpsNumber: string;
  municipalityConfirmed: boolean;
}

function rascunhoDe(c: ConfiguracaoDaNfse): Rascunho {
  return {
    mode: c.mode,
    serviceCode: c.serviceCode ?? '',
    municipalServiceCode: c.municipalServiceCode ?? '',
    nbsCode: c.nbsCode ?? '',
    serviceDescription: c.serviceDescription ?? '',
    issRate: c.issRate ?? '',
    simplesOption: c.simplesOption ?? '',
    simplesRegime: c.simplesRegime ?? '',
    specialRegime: c.specialRegime,
    issWithholding: c.issWithholding,
    dpsSeries: c.dpsSeries,
    nextDpsNumber: String(c.nextDpsNumber),
    municipalityConfirmed: Boolean(c.municipalityConfirmedAt),
  };
}

const SELECT =
  'w-full px-2 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]';

export function NfseConfigCard({ onMudou }: { onMudou?: (mensagem: string) => void }) {
  const [config, setConfig] = useState<ConfiguracaoDaNfse | null>(null);
  const [prontidao, setProntidao] = useState<ProntidaoDaNfse | null>(null);
  const [r, setR] = useState<Rascunho | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const [indisponivel, setIndisponivel] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([nfseApi.config(), nfseApi.prontidao()]);
      // Resposta sem a forma do contrato não vira formulário com "undefined".
      if (!c || typeof c.mode !== 'string') throw new Error('forma');
      setConfig(c);
      setProntidao(p && Array.isArray(p.items) ? p : null);
      setR(rascunhoDe(c));
      setIndisponivel(null);
    } catch (err) {
      setIndisponivel(err instanceof ApiRequestError ? err.message : 'Não foi possível carregar a NFS-e.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function gravar(patch: PatchDaNfse, mensagem: string) {
    setOcupado(true);
    setErro(null);
    try {
      await nfseApi.gravarConfig(patch);
      await carregar();
      onMudou?.(mensagem);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao gravar a NFS-e.');
    } finally {
      setOcupado(false);
    }
  }

  if (!config || !r) {
    // Falha de CARREGAR um cartão secundário não grita: fica dito no cartão,
    // sem roubar o `alert` da tela fiscal. O `alert` é para a gravação.
    return (
      <Card title="NFS-e da mão de obra">
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          {indisponivel ?? 'Carregando…'}
        </p>
      </Card>
    );
  }

  const set = <K extends keyof Rascunho>(k: K, v: Rascunho[K]) => setR({ ...r, [k]: v });
  const nacional = r.mode === 'EMISSOR_NACIONAL';

  const salvar = () =>
    void gravar(
      {
        mode: r.mode,
        ...(nacional
          ? {
              serviceCode: r.serviceCode.trim() || null,
              municipalServiceCode: r.municipalServiceCode.trim() || null,
              nbsCode: r.nbsCode.trim() || null,
              serviceDescription: r.serviceDescription.trim() || null,
              issRate: r.issRate.trim() || null,
              simplesOption: r.simplesOption || null,
              simplesRegime: r.simplesOption === '3' ? r.simplesRegime || null : null,
              specialRegime: r.specialRegime,
              issWithholding: r.issWithholding,
              dpsSeries: r.dpsSeries.trim(),
              nextDpsNumber: Number(r.nextDpsNumber),
              municipalityConfirmed: r.municipalityConfirmed,
            }
          : {}),
      },
      'NFS-e gravada.',
    );

  return (
    <Card
      title="NFS-e da mão de obra"
      subtitle="A peça da OS sai na NFC-e; o serviço, na NFS-e. O modo é decisão do dono; os códigos são do contador."
    >
      {erro && (
        <p
          role="alert"
          className="px-3 py-2 mb-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
        >
          {erro}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Modo" hint="Desligada: o sistema não emite, e a OS diz o que falta">
          {(p) => (
            <select {...p} className={SELECT} value={r.mode} onChange={(e) => set('mode', e.target.value as ModoDaNfse)}>
              {(Object.keys(ROTULO_DO_MODO_DA_NFSE) as ModoDaNfse[]).map((m) => (
                <option key={m} value={m}>
                  {ROTULO_DO_MODO_DA_NFSE[m]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {nacional && (
          <div className="text-[length:var(--gs-text-sm)]">
            <p className="m-0 font-semibold">
              Ambiente: {config.environment === 'production' ? 'produção' : 'homologação (produção restrita)'}
            </p>
            {config.environment !== 'production' && (
              <Button
                size="sm"
                variant="secondary"
                className="mt-1"
                loading={ocupado}
                onClick={() => void gravar({ environment: 'production' }, 'A NFS-e passou para produção.')}
              >
                Passar para produção
              </Button>
            )}
          </div>
        )}
      </div>

      {nacional && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
          <Field label="Código de tributação nacional (cTribNac)" hint="6 dígitos — do contador">
            {(p) => <Input {...p} value={r.serviceCode} onChange={(e) => set('serviceCode', e.target.value)} />}
          </Field>
          <Field label="Código municipal (opcional)" hint="3 dígitos">
            {(p) => (
              <Input {...p} value={r.municipalServiceCode} onChange={(e) => set('municipalServiceCode', e.target.value)} />
            )}
          </Field>
          <Field label="Código NBS (opcional)" hint="9 dígitos">
            {(p) => <Input {...p} value={r.nbsCode} onChange={(e) => set('nbsCode', e.target.value)} />}
          </Field>
          <Field label="Alíquota do ISS em % (opcional)" hint="ex.: 2,00 — do contador">
            {(p) => <Input {...p} value={r.issRate} onChange={(e) => set('issRate', e.target.value)} />}
          </Field>
          <Field label="Situação no Simples Nacional" hint="do contador">
            {(p) => (
              <select {...p} className={SELECT} value={r.simplesOption} onChange={(e) => set('simplesOption', e.target.value)}>
                <option value="">— escolha —</option>
                {Object.entries(SIMPLES).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {r.simplesOption === '3' && (
            <Field label="Regime de apuração (ME/EPP)" hint="do contador">
              {(p) => (
                <select {...p} className={SELECT} value={r.simplesRegime} onChange={(e) => set('simplesRegime', e.target.value)}>
                  <option value="">— escolha —</option>
                  {Object.entries(REGIME_SN).map(([v, t]) => (
                    <option key={v} value={v}>
                      {t}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <Field label="Regime especial">
            {(p) => (
              <select {...p} className={SELECT} value={r.specialRegime} onChange={(e) => set('specialRegime', e.target.value)}>
                {Object.entries(REGIME_ESPECIAL).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Retenção do ISS">
            {(p) => (
              <select {...p} className={SELECT} value={r.issWithholding} onChange={(e) => set('issWithholding', e.target.value)}>
                {Object.entries(RETENCAO).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Descrição padrão do serviço (opcional)" hint="vai antes de “Mão de obra — OS #N”">
            {(p) => (
              <Input {...p} value={r.serviceDescription} onChange={(e) => set('serviceDescription', e.target.value)} />
            )}
          </Field>
          <Field label="Série da DPS">
            {(p) => <Input {...p} value={r.dpsSeries} onChange={(e) => set('dpsSeries', e.target.value)} />}
          </Field>
          <Field label="Próximo número da DPS" hint="só anda para frente">
            {(p) => (
              <Input {...p} inputMode="numeric" value={r.nextDpsNumber} onChange={(e) => set('nextDpsNumber', e.target.value)} />
            )}
          </Field>
          <label className="flex items-center gap-2 sm:col-span-2 text-[length:var(--gs-text-sm)]">
            <input
              type="checkbox"
              checked={r.municipalityConfirmed}
              onChange={(e) => set('municipalityConfirmed', e.target.checked)}
            />
            O município do prestador está no Sistema Nacional NFS-e (confirmado com a prefeitura ou o contador)
          </label>
        </div>
      )}

      <div className="mt-3">
        <Button size="sm" loading={ocupado} onClick={salvar}>
          Gravar NFS-e
        </Button>
      </div>

      {prontidao && prontidao.items.length > 0 && (
        <ul aria-label="Checklist da NFS-e" className="list-none p-0 mt-4 mb-0 flex flex-col gap-2">
          {prontidao.items.map((i) => (
            <li key={i.key} className="text-[length:var(--gs-text-sm)]">
              <Badge tone={i.status === 'OK' ? 'success' : i.status === 'FAIL' ? 'warning' : 'neutral'}>
                {i.status === 'OK' ? 'OK' : i.status === 'FAIL' ? 'FALTA' : 'AVISO'}
              </Badge>{' '}
              <strong>{i.label}</strong> · {DONO_ROTULO[i.owner]} — {i.detail}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
