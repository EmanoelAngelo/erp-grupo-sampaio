/**
 * CONFERIR UM PACOTE RECEBIDO (GAP-PRD-176).
 *
 * O pacote do mês sai da empresa — baixado pela tela ou por e-mail — e cada
 * saída deixa o SHA-256 registrado no servidor. Este quadro responde à pergunta
 * de uma disputa: "o arquivo que está comigo é o que o sistema entregou?".
 *
 * Duas entradas para o mesmo número:
 *   - colar o SHA-256 calculado fora (`certutil -hashfile … SHA256`,
 *     `sha256sum …`);
 *   - escolher o arquivo: o número é calculado NO NAVEGADOR e só ele sobe. O
 *     zip do mês inteiro não precisa viajar de novo para ser conferido.
 *
 * O servidor reconhece o hash do .zip (aquela entrega exata) e o do
 * MANIFESTO.csv (o conteúdo, mesmo que o zip tenha sido recompactado).
 */
import { useState } from 'react';
import { Button, Card } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  pacoteDoContadorApi,
  sha256DoArquivo,
  type ConferenciaDoPacote,
  type OcorrenciaDoPacote,
} from '@/lib/api/pacoteDoContador';
import { dataHoraBR } from '@/lib/datas';

const MEIO: Record<OcorrenciaDoPacote['meio'], string> = {
  download: 'baixado pela tela',
  email: 'enviado por e-mail',
};

const ARQUIVO: Record<OcorrenciaDoPacote['arquivo'], string> = {
  zip: 'O arquivo .zip',
  manifesto: 'O MANIFESTO.csv',
};

export function ConferirPacoteCard() {
  const [hash, setHash] = useState('');
  const [resultado, setResultado] = useState<ConferenciaDoPacote | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [conferindo, setConferindo] = useState(false);

  const conferir = async (valor: string) => {
    setConferindo(true);
    setErro(null);
    setResultado(null);
    try {
      setResultado(await pacoteDoContadorApi.conferir(valor));
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível conferir agora.');
    } finally {
      setConferindo(false);
    }
  };

  const escolherArquivo = async (arquivo: Blob | undefined) => {
    if (!arquivo) return;
    setErro(null);
    setResultado(null);
    const calculado = await sha256DoArquivo(arquivo);
    if (!calculado) {
      setErro(
        'Este navegador não calcula o SHA-256 aqui. Calcule no computador '
          + '(Windows: certutil -hashfile arquivo SHA256; Linux ou macOS: sha256sum arquivo) '
          + 'e cole o número acima.',
      );
      return;
    }
    setHash(calculado);
    await conferir(calculado);
  };

  return (
    <Card
      title="Conferir um pacote recebido"
      subtitle="Cada pacote que sai da empresa deixa o SHA-256 registrado. Confira aqui se o arquivo que está com você é o que o sistema entregou."
      className="mt-5"
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
          <span className="text-[var(--gs-muted)]">
            SHA-256 do arquivo — do .zip inteiro ou só do MANIFESTO.csv de dentro dele
          </span>
          <input
            aria-label="SHA-256 do pacote"
            placeholder="64 caracteres, de 0 a 9 e de a a f"
            value={hash}
            onChange={(e) => setHash(e.target.value)}
            className="h-9 px-2 font-mono rounded-[var(--gs-radius-sm)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void conferir(hash)} loading={conferindo} disabled={!hash.trim()}>
            Conferir
          </Button>
          <label className="flex items-center gap-2 text-[length:var(--gs-text-sm)]">
            <span className="text-[var(--gs-muted)]">ou escolha o arquivo:</span>
            <input
              type="file"
              aria-label="Arquivo do pacote"
              accept=".zip,.csv"
              onChange={(e) => void escolherArquivo(e.target.files?.[0])}
            />
          </label>
        </div>

        <p className="m-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
          O arquivo escolhido não sai do seu computador: o número é calculado aqui, e só ele é
          enviado para a conferência.
        </p>

        {resultado?.encontrado && (
          <div
            role="status"
            className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)] text-[length:var(--gs-text-sm)]"
          >
            <p className="m-0 font-semibold">Reconhecido: é um pacote que o sistema entregou.</p>
            <ul className="mt-2 mb-0 pl-5">
              {resultado.ocorrencias.map((o) => (
                <li key={`${o.meio}-${o.quando}-${o.arquivo}`}>
                  {ARQUIVO[o.arquivo]} do pacote de {o.period ?? '—'}
                  {o.nomeArquivo ? ` (${o.nomeArquivo})` : ''}, {MEIO[o.meio]} em{' '}
                  {dataHoraBR(o.quando)}.
                </li>
              ))}
            </ul>
          </div>
        )}

        {resultado && !resultado.encontrado && (
          <div
            role="status"
            className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
          >
            <p className="m-0 font-semibold">Não reconhecido.</p>
            <p className="mt-1 mb-0">
              Nenhum pacote desta empresa saiu com este SHA-256. Se o zip foi extraído e
              compactado de novo, o número dele muda: confira o do MANIFESTO.csv, que está escrito
              no LEIA-ME.txt do pacote.
            </p>
          </div>
        )}

        {erro && (
          <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
            {erro}
          </p>
        )}
      </div>
    </Card>
  );
}
