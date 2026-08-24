// Gob Share — Matriz de Nodos Gubernamentales Globales.
// Fuente: Instructions reff.txt (UE-27 + US + CN + MA). Fase 1 (2026-08-06):
// capa geoespacial + metadata estatica. API_Status_Check y Protocolo_CSV_Trazabilidad
// (pipeline Herzog) quedan pendientes de backend real — ver "Siguientes Pasos" en la fuente.
//
// Cada nodo sigue el esquema doctrinal:
//   ID_Pais, Nombre_Sistema, Portal_Registro_Oficial, Gateway_eID_Auth,
//   API_Status_Check, Protocolo_CSV_Trazabilidad
//
// URLs verificadas por investigacion (2026-08-06) via WebSearch, no inventadas.
// url: null cuando la busqueda no confirmo un dominio oficial unico — el campo
// `note` explica por que (ver cada nodo). No marcar como verificado sin confirmar.
//
// world_atlas_id = ISO 3166-1 numeric id usado por world-atlas/countries-110m.json
// (necesario para el hit-test de clic sobre el globo). Malta no existe como poligono
// en la resolucion 110m (Natural Earth la omite por tamano) — nodo sin geometria,
// se relaciona en listas pero no es clicable en el globo hasta usar un atlas 50m/10m.

export const GOB_SHARE_NODES = {
  // --- Nodos Globales Clave ---
  US: {
    id_pais: 'US',
    world_atlas_id: '840',
    nombre_sistema: 'Estados Unidos',
    portal_registro_oficial: { label: 'USA.gov (Regulations.gov / SAM.gov)', url: 'https://www.usa.gov/' },
    gateway_eid_auth: { label: 'Login.gov (+ Certificados Federales PIV/CAC)', url: 'https://www.login.gov/' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  CN: {
    id_pais: 'CN',
    world_atlas_id: '156',
    nombre_sistema: 'China',
    portal_registro_oficial: { label: '国家政务服务平台 (National E-Gov Platform)', url: 'https://www.gjzwfw.gov.cn/' },
    gateway_eid_auth: {
      label: 'Código Unificado de Crédito Social / Real-Name ID',
      url: null,
      note: 'Sin URL publica unica: verificacion real-name corre via app oficial "National Network Identity Authentication" (MPS/CAC, 2025), no un sitio web equivalente a login.gov.',
    },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  MA: {
    id_pais: 'MA',
    world_atlas_id: '504',
    nombre_sistema: 'Marruecos',
    portal_registro_oficial: { label: 'Chikaya.ma (Portal Oficial de Solicitudes)', url: 'https://www.chikaya.ma/' },
    gateway_eid_auth: { label: 'CNIE (Carte Nationale d\'Identité Électronique)', url: 'https://www.cnie.ma/' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },

  // --- Unión Europea (UE-27) ---
  ES: {
    id_pais: 'ES',
    world_atlas_id: '724',
    nombre_sistema: 'España',
    portal_registro_oficial: { label: 'REC / DIR3 (Registro Electrónico Común)', url: 'https://rec.redsara.es/registro/action/are/acceso.do' },
    gateway_eid_auth: { label: 'Cl@ve / FNMT / AutoFirma', url: 'https://clave.gob.es/' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  DE: {
    id_pais: 'DE',
    world_atlas_id: '276',
    nombre_sistema: 'Alemania',
    portal_registro_oficial: { label: 'Bundesportal (Verwaltungsportal)', url: 'https://www.verwaltung.bund.de/' },
    gateway_eid_auth: { label: 'Online-Ausweis (eID) / BundID', url: 'https://id.bund.de/' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  FR: {
    id_pais: 'FR',
    world_atlas_id: '250',
    nombre_sistema: 'Francia',
    portal_registro_oficial: { label: 'Service-Public.fr (Démarches en ligne)', url: 'https://www.service-public.fr/' },
    gateway_eid_auth: { label: 'FranceConnect', url: 'https://www.franceconnect.gouv.fr/' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  IT: {
    id_pais: 'IT',
    world_atlas_id: '380',
    nombre_sistema: 'Italia',
    portal_registro_oficial: { label: 'Servizi PA', url: 'https://www.servizi.gov.it/' },
    gateway_eid_auth: { label: 'SPID / CIE (Carta d\'Identità Elettronica)', url: 'https://www.spid.gov.it/' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  PT: {
    id_pais: 'PT',
    world_atlas_id: '620',
    nombre_sistema: 'Portugal',
    portal_registro_oficial: { label: 'ePortugal.gov.pt (Balcão Único)', url: 'https://eportugal.gov.pt/' },
    gateway_eid_auth: { label: 'Chave Móvel Digital / Cartão de Cidadão', url: 'https://www.autenticacao.gov.pt/' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  NL: {
    id_pais: 'NL',
    world_atlas_id: '528',
    nombre_sistema: 'Países Bajos',
    portal_registro_oficial: { label: 'MijnOverheid / Ondernemersplein', url: 'https://www.mijnoverheid.nl/' },
    gateway_eid_auth: { label: 'DigiD / eHerkenning', url: 'https://www.digid.nl/' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  BE: {
    id_pais: 'BE',
    world_atlas_id: '056',
    nombre_sistema: 'Bélgica',
    portal_registro_oficial: { label: 'MyGov.be (Portal Federal)', url: 'https://www.mygov.be/' },
    gateway_eid_auth: {
      label: 'eID Belgie / Itsme',
      url: 'https://www.itsme-id.com/',
      note: 'Itsme es un consorcio privado (bancos/telecos), reconocido como gateway eID nacional bajo eIDAS.',
    },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  AT: {
    id_pais: 'AT',
    world_atlas_id: '040',
    nombre_sistema: 'Austria',
    portal_registro_oficial: { label: 'oesterreich.gv.at (Digitales Amt)', url: 'https://www.oesterreich.gv.at/' },
    gateway_eid_auth: { label: 'ID Austria', url: 'https://www.id-austria.gv.at/' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  PL: {
    id_pais: 'PL',
    world_atlas_id: '616',
    nombre_sistema: 'Polonia',
    portal_registro_oficial: {
      label: 'gov.pl (ePUAP integrado)',
      url: 'https://www.gov.pl/web/gov',
      note: 'ePUAP (epuap.gov.pl) es la plataforma legacy, ahora integrada en gov.pl.',
    },
    gateway_eid_auth: { label: 'Profil Zaufany / mojeID', url: 'https://www.login.gov.pl/' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  IE: {
    id_pais: 'IE',
    world_atlas_id: '372',
    nombre_sistema: 'Irlanda',
    portal_registro_oficial: { label: 'Gov.ie (Central Online Services)', url: 'https://www.gov.ie/en/' },
    gateway_eid_auth: { label: 'MyGovID', url: 'https://www.mygovid.ie/' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  SE: {
    id_pais: 'SE',
    world_atlas_id: '752',
    nombre_sistema: 'Suecia',
    portal_registro_oficial: {
      label: 'Verksamt.se (Government Services Portal)',
      url: 'https://verksamt.se/en',
      note: 'Suecia no tiene portal central unico de ciudadano equivalente a USA.gov; Verksamt.se es el portal de empresas gestionado conjuntamente por Bolagsverket/Skatteverket/Tillväxtverket.',
    },
    gateway_eid_auth: {
      label: 'BankID',
      url: 'https://www.bankid.com/en/',
      note: 'BankID lo opera un consorcio bancario, no una agencia estatal, pero es el estandar eID de facto en Suecia.',
    },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  DK: {
    id_pais: 'DK',
    world_atlas_id: '208',
    nombre_sistema: 'Dinamarca',
    portal_registro_oficial: { label: 'Virk.dk (portal de empresas) / Borger.dk (ciudadano)', url: 'https://virk.dk/' },
    gateway_eid_auth: { label: 'MitID', url: 'https://www.mitid.dk/' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  FI: {
    id_pais: 'FI',
    world_atlas_id: '246',
    nombre_sistema: 'Finlandia',
    portal_registro_oficial: { label: 'Suomi.fi (E-Services & Messages)', url: 'https://www.suomi.fi/' },
    gateway_eid_auth: {
      label: 'Suomi.fi e-Identification',
      url: 'https://www.suomi.fi/instructions-and-support/identification',
      note: 'Es una seccion del mismo dominio suomi.fi, no un sitio separado.',
    },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  EE: {
    id_pais: 'EE',
    world_atlas_id: '233',
    nombre_sistema: 'Estonia',
    portal_registro_oficial: { label: 'Eesti.ee (State Portal)', url: 'https://www.eesti.ee/' },
    gateway_eid_auth: {
      label: 'ID-kaart / Mobiil-ID (RIA)',
      url: null,
      note: 'eID estatal documentado en id.ee (RIA - Estonian Information System Authority) — URL no confirmada con certeza suficiente. Smart-ID (smart-id.com) es una app privada reconocida por el estado, no el gateway oficial primario.',
    },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  LT: {
    id_pais: 'LT',
    world_atlas_id: '440',
    nombre_sistema: 'Lituania',
    portal_registro_oficial: { label: 'Epaslaugos.lt (E-Government Gateway)', url: 'https://www.epaslaugos.lt/portal/' },
    gateway_eid_auth: {
      label: 'Mobile-ID / Smart-ID (selección en epaslaugos.lt)',
      url: null,
      note: 'Lituania no tiene un gateway eID gubernamental unico: el login se elige entre varios metodos reconocidos (Smart-ID, Mobile-ID, banco) en la propia pantalla de epaslaugos.lt. Smart-ID es un producto privado (SK ID Solutions).',
    },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  LV: {
    id_pais: 'LV',
    world_atlas_id: '428',
    nombre_sistema: 'Letonia',
    portal_registro_oficial: {
      label: 'Latvija.lv (State Services)',
      url: null,
      note: 'Dominio real probable latvija.lv (no latvija.gov.lv como en la fuente); no confirmado con certeza suficiente para marcar verificado.',
    },
    gateway_eid_auth: { label: 'eParaksts / Smart-ID', url: 'https://www.eparaksts.lv/' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  CZ: {
    id_pais: 'CZ',
    world_atlas_id: '203',
    nombre_sistema: 'Chequia',
    portal_registro_oficial: { label: 'Datové Schránky (Data Boxes official)', url: 'https://www.mojedatovaschranka.cz/' },
    gateway_eid_auth: {
      label: 'Identita občana',
      url: 'https://www.identita.gov.cz/',
      note: 'Dominio migrado desde identitaobcana.cz a identita.gov.cz.',
    },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  SK: {
    id_pais: 'SK',
    world_atlas_id: '703',
    nombre_sistema: 'Eslovaquia',
    portal_registro_oficial: { label: 'Slovensko.sk (Central Government Portal)', url: 'https://www.slovensko.sk/' },
    gateway_eid_auth: {
      label: 'eID Slovakia (login integrado en slovensko.sk)',
      url: null,
      note: 'Sin sitio de gateway separado: login via chip eID + codigo BOK o app eIDENTITA, integrado en el propio slovensko.sk.',
    },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  HU: {
    id_pais: 'HU',
    world_atlas_id: '348',
    nombre_sistema: 'Hungría',
    portal_registro_oficial: { label: 'Ügyfélkapu+ (Client Gate)', url: 'https://www.magyarorszag.hu/' },
    gateway_eid_auth: {
      label: 'Ügyfélkapu / DÁP',
      url: 'https://www.magyarorszag.hu/',
      note: 'Login Ügyfélkapu integrado en el mismo portal magyarorszag.hu, no un dominio separado.',
    },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  RO: {
    id_pais: 'RO',
    world_atlas_id: '642',
    nombre_sistema: 'Rumanía',
    portal_registro_oficial: { label: 'Ghișeul.ro / PCUe (Ventanilla Única)', url: 'https://www.ghiseul.ro/' },
    gateway_eid_auth: { label: 'ROeID', url: 'https://roeid.ro/en/home' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  BG: {
    id_pais: 'BG',
    world_atlas_id: '100',
    nombre_sistema: 'Bulgaria',
    portal_registro_oficial: { label: 'egov.bg (Single E-Services Portal)', url: 'https://egov.bg/' },
    gateway_eid_auth: {
      label: 'Evrotrust (eID nacional)',
      url: null,
      note: 'La identificacion electronica nacional la opera Evrotrust (empresa privada, notificada bajo eIDAS), no una "KEP" estatal como sugiere la fuente. URL no verificada con certeza suficiente.',
    },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  GR: {
    id_pais: 'GR',
    world_atlas_id: '300',
    nombre_sistema: 'Grecia',
    portal_registro_oficial: { label: 'Gov.gr (National Digital Portal)', url: 'https://www.gov.gr/' },
    gateway_eid_auth: {
      label: 'Taxisnet credentials (AADE)',
      url: null,
      note: 'Taxisnet lo emite AADE (autoridad tributaria) y autentica el acceso a gov.gr, pero no hay una URL de login "taxisnet.gr" separada confirmada; no marcar como verificada.',
    },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  HR: {
    id_pais: 'HR',
    world_atlas_id: '191',
    nombre_sistema: 'Croacia',
    portal_registro_oficial: { label: 'e-Građani (e-Citizens Portal)', url: 'https://gov.hr/en' },
    gateway_eid_auth: { label: 'NIAS (National Identification System)', url: 'https://nias.gov.hr/en' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  SI: {
    id_pais: 'SI',
    world_atlas_id: '705',
    nombre_sistema: 'Eslovenia',
    portal_registro_oficial: { label: 'eUprava (State Portal)', url: 'https://e-uprava.gov.si/' },
    gateway_eid_auth: { label: 'SI-PASS', url: 'https://www.si-trust.gov.si/en/si-pass' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  LU: {
    id_pais: 'LU',
    world_atlas_id: '442',
    nombre_sistema: 'Luxemburgo',
    portal_registro_oficial: { label: 'Guichet.lu (Administrative Portal)', url: 'https://guichet.public.lu/' },
    gateway_eid_auth: {
      label: 'LuXTrust',
      url: 'https://www.luxtrust.com/',
      note: 'Dominio oficial real es luxtrust.com, no luxtrust.lu.',
    },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  CY: {
    id_pais: 'CY',
    world_atlas_id: '196',
    nombre_sistema: 'Chipre',
    portal_registro_oficial: { label: 'Gov.cy', url: 'https://www.gov.cy/en/' },
    gateway_eid_auth: {
      label: 'CyLogin',
      url: 'https://cylogin.cyprus.gov.cy/',
      note: 'Dominio real es cylogin.cyprus.gov.cy, no cylogin.gov.cy.',
    },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
  MT: {
    id_pais: 'MT',
    world_atlas_id: null, // ausente en world-atlas 110m (isla pequena) — sin poligono clicable
    nombre_sistema: 'Malta',
    portal_registro_oficial: { label: 'Servizz.gov.mt', url: 'https://www.servizz.gov.mt/' },
    gateway_eid_auth: { label: 'e-ID Malta (Identity Portal)', url: 'https://eid.gov.mt/' },
    api_status_check: 'pendiente',
    protocolo_csv_trazabilidad: 'pendiente',
  },
};

export const GOB_SHARE_NODES_BY_WORLD_ATLAS_ID = Object.fromEntries(
  Object.values(GOB_SHARE_NODES)
    .filter((n) => n.world_atlas_id != null)
    .map((n) => [n.world_atlas_id, n]),
);
