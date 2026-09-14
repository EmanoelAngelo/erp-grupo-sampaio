/**
 * OS DIREITOS DO TITULAR NA FICHA DO CLIENTE (GAP-PRD-073).
 *
 * Antes, o pedido de quem é dono dos dados — "quero uma cópia do que vocês
 * guardam de mim", "quero que apaguem meu cadastro" — terminava em SQL do
 * desenvolvedor. Este bloco é o balcão desse pedido, na ficha que a gerência
 * já abre para editar:
 *
 *   - EXPORTAR baixa o documento que o SERVIDOR montou (art. 18, II e V). A
 *     tela não resume nem filtra: o que o titular recebe é o que a operação
 *     guarda, com a política de retenção junto;
 *   - ANONIMIZAR (art. 18, IV e VI) pede motivo — vai para a trilha — e um
 *     segundo clique num diálogo que diz o que sai e o que fica. Não tem
 *     volta, então o botão só habilita com o motivo escrito. A recusa com
 *     pendência (vale, título, OS na bancada) fica no diálogo, com a lista;
 *   - a POLÍTICA DE RETENÇÃO carrega quando alguém pede, para responder "o que
 *     fica guardado depois?" sem inventar.
 *
 * Só aparece para quem o servidor atende nessas rotas (gerência e dono): a
 * decisão sobre o titular é de quem responde pela operação.
 */
import { useState } from 'react';
import { prenderFoco } from './armadilhaDeFoco';
import { Button, Card, Field, Input } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { salvarArquivo } from '@/lib/download';
import {
  lgpdApi,
  pendenciasDoErro,
  type PendenciaDoTitular,
  type RegraDeRetencao,
} from '@/lib/api/lgpd';

/** O mesmo mínimo do servidor (`anonimizarTitular`). */
const MOTIVO_MINIMO = 10;

function hoje(): string {
  return new Date().toISOString().slice(0, 10);
}

export function DireitosDoTitular({
  cliente,
  onExportado,
  onAnonimizado,
}: {
  cliente: { id: string; name: string };
  onExportado: (nome: string) => void;
  onAnonimizado: (nome: string) => void;
}) {
  const [exportando, setExportando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [anonimizando, setAnonimizando] = useState(false);
  const [recusa, setRecusa] = useState<{ mensagem: string; pendencias: PendenciaDoTitular[] } | null>(
    null,
  );
  const [retencao, setRetencao] = useState<RegraDeRetencao[] | null>(null);
  const [carregandoRetencao, setCarregandoRetencao] = useState(false);

  const exportar = async () => {
    setErro(null);
    setExportando(true);
    try {
      const documento = await lgpdApi.exportar(cliente.id);
      salvarArquivo(
        new Blob([JSON.stringify(documento, null, 2)], { type: 'application/json;charset=utf-8' }),
        `titular-${cliente.id}-${hoje()}.json`,
      );
      onExportado(cliente.name);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível exportar os dados do titular.');
    } finally {
      setExportando(false);
    }
  };

  const abrirConfirmacao = () => {
    setErro(null);
    setRecusa(null);
    setMotivo('');
    setConfirmando(true);
  };

  const anonimizar = async () => {
    setAnonimizando(true);
    setRecusa(null);
    try {
      await lgpdApi.anonimizar(cliente.id, motivo.trim());
      setConfirmando(false);
      setMotivo('');
      onAnonimizado(cliente.name);
    } catch (err) {
      setRecusa(
        err instanceof ApiRequestError
          ? { mensagem: err.message, pendencias: pendenciasDoErro(err) }
          : { mensagem: 'Não foi possível anonimizar o titular.', pendencias: [] },
      );
    } finally {
      setAnonimizando(false);
    }
  };

  const alternarRetencao = async () => {
    if (retencao) {
      setRetencao(null);
      return;
    }
    setErro(null);
    setCarregandoRetencao(true);
    try {
      setRetencao(await lgpdApi.retencao());
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível carregar a política de retenção.');
    } finally {
      setCarregandoRetencao(false);
    }
  };

  return (
    <Card title="Direitos do titular (LGPD)" className="mb-5">
      <p className="m-0 mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
        O pedido de quem é dono destes dados: receber uma cópia de tudo o que esta operação guarda
        dele, ou ter o contato apagado. Vendas, notas e ordens de serviço continuam existindo — o
        que sai é o contato.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" loading={exportando} onClick={() => void exportar()}>
          Exportar dados do titular
        </Button>
        <Button variant="danger" onClick={abrirConfirmacao}>
          Anonimizar titular
        </Button>
        <Button variant="ghost" loading={carregandoRetencao} onClick={() => void alternarRetencao()}>
          {retencao ? 'Esconder a política de retenção' : 'Ver a política de retenção'}
        </Button>
      </div>

      {erro && (
        <p role="alert" className="mt-3 mb-0 text-[var(--gs-danger)]">
          {erro}
        </p>
      )}

      {retencao && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
            <thead>
              <tr className="text-left text-[var(--gs-muted)]">
                <th className="py-1 pr-3 font-semibold">O que</th>
                <th className="py-1 pr-3 font-semibold">Por quanto tempo</th>
                <th className="py-1 pr-3 font-semibold">Por quê</th>
                <th className="py-1 font-semibold">Depois</th>
              </tr>
            </thead>
            <tbody>
              {retencao.map((r) => (
                <tr key={r.chave} className="border-t border-[var(--gs-border)] align-top">
                  <td className="py-2 pr-3">{r.oQue}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{r.prazo}</td>
                  <td className="py-2 pr-3">{r.base}</td>
                  <td className="py-2">{r.destino}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmando && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          ref={prenderFoco}
          tabIndex={-1}
          aria-label={`Anonimizar ${cliente.name}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !anonimizando) setConfirmando(false);
          }}
        >
          <div className="w-full max-w-lg rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
            <header className="px-6 py-4 border-b border-[var(--gs-border)]">
              <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] m-0">
                Anonimizar {cliente.name}?
              </h2>
            </header>
            <div className="px-6 py-5 flex flex-col gap-4">
              <p className="m-0 text-[length:var(--gs-text-base)]">
                Nome, CPF/CNPJ, telefone, e-mail, endereço e observações saem do cadastro — e também
                dos contatos comerciais ligados a ele, do nome copiado nas ordens de serviço e das
                cópias guardadas para a central. <strong>Não tem volta.</strong>
              </p>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Continuam guardados, pelo prazo legal: as notas fiscais emitidas, as vendas, os
                títulos e a trilha de auditoria — agora apontando para “Titular anonimizado”.
              </p>
              <Field label="Motivo" hint="Quem pediu, por qual canal e quando — vai para a trilha de auditoria">
                {(p) => (
                  <Input
                    {...p}
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    placeholder="Ex.: pedido da titular por e-mail em 11/09"
                    autoFocus
                  />
                )}
              </Field>
              {recusa && (
                <div
                  role="alert"
                  className="px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
                >
                  <p className="m-0">{recusa.mensagem}</p>
                  {recusa.pendencias.length > 0 && (
                    <ul className="m-0 mt-2 pl-5">
                      {recusa.pendencias.map((p) => (
                        <li key={p.chave}>{p.descricao}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-3">
                <Button variant="ghost" disabled={anonimizando} onClick={() => setConfirmando(false)}>
                  Cancelar
                </Button>
                <Button
                  variant="danger"
                  loading={anonimizando}
                  disabled={motivo.trim().length < MOTIVO_MINIMO}
                  onClick={() => void anonimizar()}
                >
                  Anonimizar definitivamente
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
