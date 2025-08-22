/**
 * Pegamos a API do UOL criada pelo projeto
 * recuperamos todos os jogos do dia com os canais
 * e, 
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const UOL = require('uol-simple-api-futebol');
const fs = require('fs');


// --- CONFIGURAÇÕES ---
const {
    DB_HOST, DB_USER, DB_PASSWORD, DB_NAME,
    CATEGORY_NAME_DESTINATION, URL_JOGOS_DO_DIA
} = process.env;

if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_NAME) {
    console.error("ERRO: Configure todas as variáveis no arquivo .env");
    process.exit(1);
}


async function fecthGamesAndSource() {
    try {
        const games = await UOL.default();
        const formattedGames = [];
        const data = fs.readFileSync('./sources.json', 'utf-8');
        const jogos = JSON.parse(data);
        const channels = getChannelsSource(games, jogos);
        
        return channels;
    } catch (err) {
        console.error("Erro ao buscar jogos do dia: ", err.message);
        return [];
    }
}

function getChannelsSource(jogos, canaisFonte) {
  // Mapeamento entre nome que vem da API e o "type" da lista de canais
  const canalMap = {
    'Disney+': 'disney',
    'ESPN': 'espn',
    'ESPN 4': 'espn4',
    'CazéTV': 'cazetv',
    'RedeTV': 'redetv'
    // tendo mais fontes adicione mais aqui
  };

  let resultado = [];

    // Jogo do dia como primeiro, caso haja
    if(URL_JOGOS_DO_DIA != '') {
        resultado.push({
            name: `JOGOS DO DIA`,
            url: URL_JOGOS_DO_DIA,
            logo: 'https://cdn-icons-png.flaticon.com/512/1165/1165218.png',
        });
    }

  for (const jogo of jogos) {
    for (const canal of jogo.canais) {
      const type = canalMap[canal];
      if (!type) continue; // ignora se não tiver no mapeamento

      // pega todas as opções disponíveis para esse canal
      const opcoes = canaisFonte.filter(c => c.type === type);

      for (const opc of opcoes) {
        let sufixo = opc.quality;

        // se tiver mais de uma opção da mesma qualidade, precisa diferenciar
        const repetidas = opcoes.filter(o => o.quality === opc.quality);
        if (repetidas.length > 1) {
          const index = repetidas.indexOf(opc);
          if (index > 0) {
            sufixo += ` ${index + 1}`; // exemplo: FHD 2, FHD 3
          }
        }

        resultado.push({
            name: `${jogo.times[0]} x ${jogo.times[1]} - ${jogo.hora} - ${sufixo} (${canal.toUpperCase()})`,
            url: opc.url,
            logo: 'https://cdn-icons-png.flaticon.com/512/1165/1165218.png',
        });
      }
    }
  }

  return resultado;
}

async function main() {
    console.log("Iniciando sincronização via Xtream API...");
    let dbPool;
    try {
        dbPool = mysql.createPool({
            host: DB_HOST,
            user: DB_USER,
            password: DB_PASSWORD,
            database: DB_NAME,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });

        console.log("Conectado ao MySQL.");
        const games = await fecthGamesAndSource();

        console.log(`Encontrados ${games.length} canais de jogos para serem adicionados.`);

        const connection = await dbPool.getConnection();
        await connection.beginTransaction();

        try {
            // --- Deletar canais antigos dessa categoria ---
            const [oldCats] = await connection.query(
                "SELECT id FROM streams_categories WHERE category_name IN (?)",
                [CATEGORY_NAME_DESTINATION]
            );
            let oldStreamIds = [];

            if (oldCats.length > 0) {
                const catIds = oldCats.map(c => c.id);

                const [oldStreams] = await connection.query(
                    `SELECT id FROM streams WHERE category_id = ?`,
                    `[${catIds[0]}]`
                );
                oldStreamIds = oldStreams.map(s => s.id);

                if (oldStreams.length > 0) {
                    await connection.query(`DELETE FROM streams_servers WHERE stream_id IN (${oldStreamIds.map(() => '?').join(',')})`,
                        oldStreamIds
                    );
                    await connection.query(`DELETE FROM streams WHERE id IN (${oldStreamIds.map(() => '?').join(',')})`,
                        oldStreamIds
                    );
                }
            }

            // --- Inserir a nova categoria de destino ---
            let categoryId = oldCats[0]?.id;
            if(!categoryId) {
                const [catRes] = await connection.query(
                    "INSERT INTO streams_categories (category_type, category_name, cat_order) VALUES (?, ?, ?)",
                    ['live', CATEGORY_NAME_DESTINATION, 1]
                );
                categoryId = catRes.insertId;
            }

            // --- Inserir os canais da Xtream ---
            const newStreamIds = [];

            for (let i = 0; i < games.length; i++) {
                const c = games[i];
                const [res] = await connection.query(
                    "INSERT INTO streams (type, category_id, stream_display_name, stream_source, stream_icon, read_native, `order`, added, gen_timestamps, direct_source, allow_record, probesize_ondemand) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        1,
                        `[${categoryId}]`,
                        c.name,
                        `["${c.url}"]`,
                        c.logo,
                        false,
                        i + 1,
                        Math.floor(Date.now() / 1000),
                        false,
                        false,
                        false,
                        542000
                    ]
                );

                const streamId = res.insertId;
                newStreamIds.push(streamId);

                await connection.query(
                    "INSERT INTO streams_servers (stream_id, server_id, on_demand) VALUES (?, ?, ?)",
                    [streamId, 1, true]
                );
            }

            // --- Atualizar bouquets ---
            console.log("Atualizando bouquets...");
            const [bouquets] = await connection.query("SELECT id, bouquet_name, bouquet_channels FROM bouquets");

            for (const b of bouquets) {
                // bouquet_channels vem como string "[1010, 1515]"
                let currentChannels = [];
                try {
                    currentChannels = JSON.parse(b.bouquet_channels || "[]");
                } catch {
                    currentChannels = [];
                }

                // 1) Remover canais antigos (streamIds que foram deletados)
                currentChannels = currentChannels.filter(ch => !oldStreamIds.includes(ch));

                // 2) Adicionar os novos canais
                const updatedChannels = [...new Set([...currentChannels, ...newStreamIds])];

                // 3) Atualizar no banco
                await connection.query(
                    "UPDATE bouquets SET bouquet_channels = ? WHERE id = ?",
                    [JSON.stringify(updatedChannels), b.id]
                );
            }

            await connection.commit();
            console.log("✅ Sincronização concluída!");
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }

    } catch (err) {
        console.error("Erro:", err.message);
    } finally {
        if (dbPool) await dbPool.end();
        console.log("Pool de conexões encerrado.");
    }
}

main();
