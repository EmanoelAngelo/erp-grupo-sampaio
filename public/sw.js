/*
 * Service worker do Grupo Sampaio ERP.
 *
 * O QUE ELE FAZ: guarda a CASCA do aplicativo e os PEDAÇOS de todas as telas,
 * para a tela abrir quando o servidor não responde. Sem isto, servidor fora do
 * ar significa página em branco — e quem está no balcão não consegue nem ver a
 * venda que ficou pendente na fila.
 *
 * O QUE ELE NÃO FAZ, DE PROPÓSITO: cachear resposta de API.
 *
 * Guardar dado de estoque, preço ou caixa e servir depois faria a tela mostrar
 * número velho como se fosse atual — e no balcão isso vira venda com preço
 * errado ou baixa de peça que já não existe. Requisição para a API sempre vai à
 * rede; se falhar, quem trata é a fila de escrita, que sabe o que pode ser
 * reenviado com segurança.
 *
 * OS PEDAÇOS DAS TELAS (GAP-PRD-210)
 *
 * O build deixou de ser um pacote único: cada tela é um pedaço baixado quando
 * alguém a abre (src/router/telas.tsx). Guardar só "o que passou por aqui"
 * deixaria sem rede toda tela que ninguém abriu desde o último deploy. Por
 * isso o build escreve `sw-precache.json` com TODOS os pedaços
 * (src/lib/build/configuracaoDoBuild.ts), e este arquivo baixa a lista
 * inteira:
 *
 *   - na instalação, logo depois da casca;
 *   - a cada abertura do sistema com rede. Este arquivo é o mesmo de um build
 *     para o outro — o navegador não o reinstala a cada deploy —, mas a lista
 *     muda: é a abertura seguinte ao deploy que guarda os pedaços novos e
 *     descarta os velhos, que nenhum index novo cita.
 *
 * O PDV e o login não dependem disto: vão no pacote inicial, que a casca cita.
 *
 * Pedaço com hash no nome é imutável — o conteúdo muda, o nome muda. Por isso
 * ele sai do que está guardado ANTES de ir à rede: no balcão com rede fraca,
 * abrir a tela não espera um download que já foi feito.
 */

/* global self, caches, fetch, URL -- os globais do service worker */

const CACHE = 'gs-casca-v1';

/* O esqueleto, pelo nome. Os pedaços vêm da lista que o build escreve. */
const ESSENCIAL = ['/', '/index.html'];

/* Escrita pelo build ao lado deste arquivo. Sem ela (desenvolvimento, build
 * antigo), fica o comportamento de antes: guarda o que passar. */
const LISTA = 'sw-precache.json';

/* A última versão da lista guardada POR INTEIRO. Em memória: se o navegador
 * desligar o service worker, a próxima abertura confere tudo de novo — o que
 * já está guardado não é baixado outra vez. */
let versaoGuardada = null;
let guardando = null;

function enderecoDe(caminho) {
  return new URL(caminho, self.location.href).href;
}

function ehPedaco(endereco) {
  return new URL(endereco).pathname.includes('/assets/');
}

/* Rota do aplicativo (sem extensão no fim): o servidor responde a casca. */
function ehEnderecoDeTela(url) {
  const ultimo = url.pathname.split('/').pop() || '';
  return !/\.[A-Za-z0-9]+$/.test(ultimo);
}

async function lerLista() {
  let res;
  try {
    res = await fetch(enderecoDe(LISTA), { cache: 'no-store' });
  } catch {
    return null;
  }
  if (!res || !res.ok) return null;
  try {
    const corpo = await res.json();
    if (!corpo || typeof corpo.versao !== 'string' || !Array.isArray(corpo.arquivos)) return null;
    return {
      versao: corpo.versao,
      arquivos: corpo.arquivos.filter((a) => typeof a === 'string').map(enderecoDe),
    };
  } catch {
    return null;
  }
}

/*
 * A casca que cita os pedaços da lista. A instalação a guarda, mas este arquivo
 * não muda de um deploy para o outro — sem guardá-la de novo aqui, a casca
 * guardada seguiria citando o pacote inicial do build anterior, que a poda
 * tira. As duas entradas vêm da rede antes de qualquer uma ser trocada.
 */
async function guardarACasca(cache) {
  const novas = await Promise.all(
    ESSENCIAL.map(async (caminho) => {
      const res = await fetch(enderecoDe(caminho), { cache: 'no-store' });
      if (!res || !res.ok) throw new Error(`${caminho} respondeu ${res ? res.status : 'nada'}`);
      return [caminho, res];
    }),
  );
  for (const [caminho, res] of novas) await cache.put(enderecoDe(caminho), res);
}

async function guardarAsTelas(cascaJaFresca) {
  const lista = await lerLista();
  if (!lista || lista.versao === versaoGuardada) return;

  const cache = await caches.open(CACHE);
  const resultados = await Promise.allSettled(
    lista.arquivos.map(async (endereco) => {
      if (await cache.match(endereco)) return;
      const res = await fetch(endereco);
      if (!res || !res.ok) throw new Error(`${endereco} respondeu ${res ? res.status : 'nada'}`);
      await cache.put(endereco, res);
    }),
  );

  // Um pedaço da lista nova faltou: nada troca de lado. A casca guardada e os
  // pedaços que ELA cita continuam abrindo sem rede, e a próxima abertura com
  // rede busca de novo o que falhou.
  if (!resultados.every((r) => r.status === 'fulfilled')) return;

  // Com todos os pedaços novos guardados, a casca nova — só então a poda.
  if (!cascaJaFresca) await guardarACasca(cache);

  // Pedaço de build anterior: nenhum index atual o cita, e sem a poda cada
  // deploy somaria outro pacote inteiro ao que o navegador guarda.
  const atuais = new Set(lista.arquivos);
  for (const guardado of await cache.keys()) {
    if (ehPedaco(guardado.url) && !atuais.has(guardado.url)) await cache.delete(guardado);
  }

  versaoGuardada = lista.versao;
}

/* Uma rodada por vez: duas abas abrindo juntas não baixam a lista em dobro. */
function guardarAsTelasUmaVez(cascaJaFresca = false) {
  if (!guardando) {
    guardando = guardarAsTelas(cascaJaFresca)
      .catch(() => {
        // Falhar aqui não pode impedir o sistema de abrir nem o SW de instalar.
      })
      .finally(() => {
        guardando = null;
      });
  }
  return guardando;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ESSENCIAL))
      // A casca acabou de vir da rede: não precisa buscá-la de novo.
      .then(() => guardarAsTelasUmaVez(true))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((chaves) =>
        Promise.all(chaves.filter((c) => c !== CACHE).map((c) => caches.delete(c))),
      )
      .then(() => self.clients.claim()),
  );
});

async function pedacoGuardadoOuRede(req) {
  const guardado = await caches.match(req);
  if (guardado) return guardado;
  const res = await fetch(req);
  if (res && res.status === 200 && res.type === 'basic') {
    const copia = res.clone();
    const cache = await caches.open(CACHE);
    await cache.put(req, copia);
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API NUNCA vem do cache. Dado velho servido como atual é pior que erro
  // honesto de conexão.
  if (url.pathname.startsWith('/api/')) return;

  // Outra origem (a API costuma estar em outra porta) também não.
  if (url.origin !== self.location.origin) return;

  // A lista é o que diz se houve deploy: guardada, ela mentiria.
  if (url.pathname.endsWith(`/${LISTA}`)) return;

  if (ehPedaco(req.url)) {
    event.respondWith(pedacoGuardadoOuRede(req));
    return;
  }

  const daRede = fetch(req);

  // Abrir o sistema com rede é a hora de conferir a lista: é o que traz os
  // pedaços do deploy novo antes de a rede cair.
  if (req.mode === 'navigate') {
    event.waitUntil(
      daRede.then((res) => (res && res.ok ? guardarAsTelasUmaVez() : undefined)).catch(() => undefined),
    );
  }

  event.respondWith(
    daRede
      .then((res) => {
        // Guarda o que veio bem, para a próxima abertura sem rede.
        if (res && res.status === 200 && res.type === 'basic') {
          const copia = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copia));
        }
        return res;
      })
      .catch(async () => {
        // Endereço de tela sem rede: a casca ATUAL, que é a que cita os pedaços
        // guardados. A cópia deste endereço pode ser de um build anterior, e o
        // pacote que ela cita já foi podado.
        if (req.mode === 'navigate' && ehEnderecoDeTela(url)) {
          const casca = await caches.match('/index.html');
          if (casca) return casca;
        }
        const guardado = await caches.match(req);
        if (guardado) return guardado;
        // Navegação sem nada no cache cai no index: é o que faz o aplicativo
        // abrir em vez de mostrar erro do navegador.
        if (req.mode === 'navigate') {
          const casca = await caches.match('/index.html');
          if (casca) return casca;
        }
        throw new Error('offline e sem cópia local');
      }),
  );
});
