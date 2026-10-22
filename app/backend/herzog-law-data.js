/**
 * Datos de referencia de Herzog LaW: catalogo inicial de marcos normativos y
 * datos publicos de CBAM. El catalogo solo se inserta cuando falta un marco; lo
 * que la Direccion edite despues (estado, certificado, responsable) no se pisa.
 * Orientacion interna: no sustituye a un organismo de certificacion ni a una
 * asesoria juridica.
 */

/* Subir cuando se anada un marco al catalogo para que se inserte en los tenants existentes. */
export const SEED_VERSION = 2;

const REF = {
  cbamPage: { label: 'Comisión Europea · CBAM, régimen definitivo', url: 'https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-definitive-regime_en' },
  cbamGuidance: { label: 'Comisión Europea · CBAM, legislación y guías', url: 'https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-legislation-and-guidance_en' },
  cbamQa: { label: 'Comisión Europea · CBAM, preguntas y respuestas (biomasa)', url: 'https://taxation-customs.ec.europa.eu/document/download/013fa763-5dce-4726-a204-69fec04d5ce2_en?filename=CBAM_Questions+and+Answers.pdf' },
  oepm: { label: 'OEPM · cuestiones básicas de patentes y modelos de utilidad', url: 'https://www.oepm.es/cs/OEPMSite/contenidos/Folletos/cuestiones_basicas_Patentes_y_ModUti.html' },
  modeloUtilidad: { label: 'Administración.gob.es · modelo de utilidad', url: 'https://administracion.gob.es/tu-espacio-europeo/derechos-obligaciones/empresas/inicio-gestion-cierre/derechos/patentes-marcas/modelo-utilidad' },
  pymeInnovadora: { label: 'Guía del sello PYME Innovadora (impulsa-empresa.es)', url: 'https://impulsa-empresa.es/wp-content/uploads/2025/02/Sello-Pyme-Innovadora.pdf' },
  espanaEmprende: { label: 'Cámara de España · folleto de España Emprende', url: 'https://camara.es/sites/default/files/Folleto%20Espa%C3%B1a%20Emprende_compressed.pdf' },
  sandbag: { label: 'Sandbag · CBAM y exportaciones de Argelia', url: 'https://sandbag.be/2026/02/20/eu-cbam-algeria-iron-exports/' },
  machinery: { label: 'EU-OSHA · Reglamento (UE) 2023/1230 de máquinas', url: 'https://osha.europa.eu/en/legislation/directive/regulation-20231230eu-machinery' },
  atex: { label: 'Directivas ATEX (resumen)', url: 'https://en.wikipedia.org/wiki/ATEX_directives' },
  ianorAtex: { label: 'IANOR · ficha técnica ATEX', url: 'https://www.ianor.dz/wp-content/uploads/2023/06/FFT-atex_.pdf' },
  iso17225: { label: 'ISO · ficha de ISO 17225-6', url: 'https://www.iso.org/standard/76093.html' },
};

export const FRAMEWORK_SEED = [
  /* ---- Gestión ---- */
  {
    id: 'iso-9001', code: 'ISO 9001', title: 'Gestión de la calidad', kind: 'iso', family: 'Gestión',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'media',
    summary: 'Sistema de calidad certificable: procesos escritos, controles y mejora continua para que cada equipo y cada lote salgan igual.',
    why: 'S-NFI vende un estándar OEM repetible. Esta certificación es la prueba externa de que el proceso se repite igual en cada nodo y suele ser requisito de entrada en licitaciones industriales y públicas.',
    requirements: [
      'Definir el alcance: diseño, fabricación bajo acuerdo, integración y puesta en marcha de los módulos BioHybrid.',
      'Mapa de procesos con un responsable por proceso.',
      'Control de documentos y registros: procedimientos, versiones y quién aprueba.',
      'Evaluación y seguimiento de proveedores y fabricantes con acuerdo de fabricación.',
      'Auditoría interna y revisión anual por la Dirección.',
      'Auditoría de certificación por una entidad acreditada.',
    ],
  },
  {
    id: 'iso-14001', code: 'ISO 14001', title: 'Gestión ambiental', kind: 'iso', family: 'Gestión',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'media',
    summary: 'Sistema de gestión ambiental certificable: identifica los impactos de la actividad, cumple la ley y los reduce de forma medible.',
    why: 'El negocio es ambiental (residuo a energía). Sin un sistema ambiental certificado, cualquier afirmación de impacto queda sin respaldo formal frente a clientes y administraciones.',
    requirements: [
      'Identificar aspectos e impactos ambientales de cada módulo: ruido, polvo, olores, vertidos y consumo de energía y agua.',
      'Listar los requisitos legales ambientales de cada país de despliegue (España, UE y Argelia) y cómo se cumplen.',
      'Fijar objetivos ambientales medibles y un programa para alcanzarlos.',
      'Control operacional y plan de emergencias, incluidos incendio y explosión.',
      'Auditoría interna, revisión por la Dirección y auditoría de certificación.',
    ],
  },
  {
    id: 'iso-45001', code: 'ISO 45001', title: 'Seguridad y salud en el trabajo', kind: 'iso', family: 'Gestión',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'alta',
    summary: 'Sistema de seguridad y salud laboral certificable: identifica peligros, evalúa riesgos y protege a las personas.',
    why: 'Triturar y secar residuo orgánico implica maquinaria en movimiento, calor, polvo y riesgo de explosión. Las grandes industrias suelen pedir esta certificación a sus contratistas.',
    requirements: [
      'Identificar peligros y evaluar riesgos de cada módulo y de cada tarea: instalación, operación y mantenimiento.',
      'Incluir el riesgo de atmósferas explosivas y enlazarlo con el cumplimiento ATEX.',
      'Consulta y participación de los trabajadores, con formación documentada.',
      'Procedimiento de investigación de incidentes y acciones correctivas.',
      'Plan de emergencias con simulacros.',
      'Auditoría interna y auditoría de certificación.',
    ],
  },
  {
    id: 'iso-50001', code: 'ISO 50001', title: 'Gestión de la energía', kind: 'iso', family: 'Gestión',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'media',
    summary: 'Sistema de gestión de la energía certificable: mide cuánta energía consume cada proceso y la reduce con objetivos.',
    why: 'El producto es energía y el deshidratador consume energía térmica y eléctrica. Medir el balance energético respalda con datos las cifras de rendimiento y ahorro.',
    requirements: [
      'Establecer la línea base energética de cada nodo, en kWh por tonelada tratada.',
      'Instalar medición por módulo.',
      'Definir indicadores de desempeño energético y objetivos anuales.',
      'Revisión energética periódica y auditoría interna.',
    ],
  },

  /* ---- Datos e IA ---- */
  {
    id: 'iso-27001', code: 'ISO/IEC 27001', title: 'Seguridad de la información', kind: 'iso', family: 'Datos e IA',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'media',
    summary: 'Sistema de seguridad de la información certificable: protege la confidencialidad, la integridad y la disponibilidad de los datos y del software.',
    why: 'El valor de S-NFI está en el software propietario y en los datos del proceso. Los grandes clientes e infraestructuras críticas exigen un sistema de seguridad de la información certificado antes de integrar.',
    requirements: [
      'Definir el alcance: SYSTEMS, plataformas de datos y entornos de despliegue.',
      'Análisis de riesgos y declaración de aplicabilidad de los controles.',
      'Reunir las evidencias que SYSTEMS ya genera: control de acceso, registros inmutables con cadena de hashes y Sentinel.',
      'Gestión de proveedores y servicios externos, coherente con la soberanía de datos.',
      'Auditoría interna y auditoría de certificación.',
    ],
  },
  {
    id: 'iso-42001', code: 'ISO/IEC 42001', title: 'Gestión de sistemas de inteligencia artificial', kind: 'iso', family: 'Datos e IA',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'vigilar',
    summary: 'Sistema de gestión de la IA: gobierna cómo se diseña, se usa y se supervisa.',
    why: 'La Physical AI actúa sobre procesos físicos. Esta norma ordena la gobernanza de la IA (riesgos, supervisión humana, trazabilidad) y es coherente con la doctrina de que el ser humano autoriza.',
    requirements: [
      'Inventario de los sistemas de IA y de su finalidad.',
      'Evaluación de riesgos e impacto de cada sistema.',
      'Supervisión humana documentada para toda acción con efecto físico.',
      'Trazabilidad de datos, versiones y decisiones.',
    ],
  },

  /* ---- Producto y combustible ---- */
  {
    id: 'iso-17225-1', code: 'ISO 17225-1', title: 'Biocombustibles sólidos: requisitos generales y clases', kind: 'iso', family: 'Producto y combustible',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'alta',
    summary: 'Marco general que clasifica los biocombustibles sólidos por origen y por calidad. Las partes 2 y 6 fijan las clases de los pellets.',
    why: 'La base de conocimiento deja pendiente la clasificación normativa del biocombustible que produce S-NFI. Esta serie es el camino estándar para definirla y vender el biopellet con una calidad garantizada.',
    requirements: [
      'Clasificar el origen de cada tipo de residuo de entrada con la tabla de origen de la norma.',
      'Decidir qué parte de la serie aplica al producto: leñoso (parte 2) o no leñoso (parte 6).',
      'Definir la ficha del biopellet: clase de calidad objetivo y límite de cada propiedad.',
      'Plan de muestreo y ensayo por lote en laboratorio acreditado. Ensayos de referencia: poder calorífico (ISO 18125) y humedad (serie ISO 18134).',
      'Declaración del productor para cada lote vendido.',
    ],
  },
  {
    id: 'iso-17225-6', code: 'ISO 17225-6', title: 'Pellets no leñosos graduados', kind: 'iso', family: 'Producto y combustible',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'alta',
    summary: 'Clases de calidad para pellets de biomasa herbácea, de fruta, acuática o mezclas.',
    why: 'Si el residuo de entrada es vegetal no leñoso (restos de cultivo, fruta, herbáceas), el pellet encaja aquí. Permite fijar una calidad comparable entre lotes y clientes.',
    requirements: [
      'Confirmar que el origen del residuo entra en el alcance de la norma.',
      'Fijar la clase de calidad objetivo del pellet.',
      'Validar con un laboratorio acreditado que el producto cumple esa clase.',
      'Controlar la humedad final (objetivo del proceso: 7-8 %) y el comportamiento de las cenizas.',
    ],
    references: [REF.iso17225],
  },
  {
    id: 'iso-17225-2', code: 'ISO 17225-2', title: 'Pellets de madera graduados', kind: 'iso', family: 'Producto y combustible',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'vigilar',
    summary: 'Clases de calidad para pellets de madera.',
    why: 'Solo aplica si parte de la entrada es biomasa leñosa. Se mantiene como alternativa según el origen del residuo de cada cliente.',
    requirements: [
      'Comprobar si el residuo del cliente es leñoso.',
      'Si lo es, repetir la clasificación y el plan de ensayo de la parte 1 con las clases de esta parte.',
    ],
  },

  /* ---- Carbono y clima ---- */
  {
    id: 'iso-14040-44', code: 'ISO 14040 / 14044', title: 'Análisis de ciclo de vida', kind: 'iso', family: 'Carbono y clima',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'alta',
    summary: 'Método para calcular el impacto ambiental de un producto desde que se genera el residuo hasta que se usa el pellet.',
    why: 'La base de conocimiento indica que la consolidación institucional del impacto de S-NFI requiere certificación independiente y un análisis de ciclo de vida homologado.',
    requirements: [
      'Definir objetivo, alcance y unidad funcional, por ejemplo una tonelada de biopellet.',
      'Inventario de entradas y salidas: residuo, energía, transporte evitado y emisiones.',
      'Evaluación de impacto y análisis de sensibilidad.',
      'Revisión crítica por un tercero independiente, obligatoria si se publican comparaciones.',
    ],
  },
  {
    id: 'iso-14064-2', code: 'ISO 14064-2', title: 'Gases de efecto invernadero: proyectos de reducción', kind: 'iso', family: 'Carbono y clima',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'alta',
    summary: 'Cómo cuantificar, monitorizar y reportar la reducción de emisiones de un proyecto.',
    why: 'S-NFI emite reporting climático y certificados CIBE basados en emisiones evitadas. Esta norma da el método para que esas cifras se puedan defender.',
    requirements: [
      'Definir el escenario base (qué pasaría con el residuo sin S-NFI) y el escenario del proyecto.',
      'Documentar las fuentes de emisión incluidas y las excluidas.',
      'Plan de monitorización con datos medidos por el módulo.',
      'Informe del proyecto listo para un verificador independiente.',
      'Comprobar la coherencia con los criterios del Artículo 6.4 del Acuerdo de París citados en la comunicación de S-NFI.',
    ],
  },
  {
    id: 'iso-14064-3', code: 'ISO 14064-3', title: 'Gases de efecto invernadero: validación y verificación', kind: 'iso', family: 'Carbono y clima',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'media',
    summary: 'Reglas que sigue un verificador independiente para dar fe de las cifras de emisiones.',
    why: 'Las cifras de mitigación de S-NFI necesitan un tercero acreditado que las verifique antes de usarse como certificado o de presentarse como verificadas.',
    requirements: [
      'Seleccionar un verificador acreditado.',
      'Preparar los datos y las evidencias que pedirá.',
      'Obtener una declaración de verificación por periodo.',
      'Usar la palabra «verificado» en web e informes solo cuando exista esa declaración.',
    ],
  },
  {
    id: 'iso-14067', code: 'ISO 14067', title: 'Huella de carbono de producto', kind: 'iso', family: 'Carbono y clima',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'media',
    summary: 'Método para calcular la huella de carbono de un producto a lo largo de su ciclo de vida.',
    why: 'Es la base para sostener afirmaciones como «neutral en carbono». Sin un cálculo verificado, esas frases no deben usarse en público.',
    requirements: [
      'Calcular la huella por tonelada de biopellet con el mismo análisis de ciclo de vida.',
      'Someter el cálculo a verificación independiente.',
      'Revisar las afirmaciones públicas de neutralidad y de mitigación verificada y alinearlas con el resultado.',
    ],
  },

  /* ---- Seguridad y explosiones ---- */
  {
    id: 'ce-maquinas', code: 'Reglamento (UE) 2023/1230', title: 'Reglamento de máquinas (marcado CE)', kind: 'ue', family: 'Seguridad y explosiones',
    jurisdictions: ['UE', 'ES'], nature: 'obligatoria', priority: 'alta',
    appliesWhen: 'Al comercializar o poner en servicio máquinas en la UE. Se aplica desde el 20 de enero de 2027 y sustituye a la Directiva 2006/42/CE.',
    summary: 'Ley europea que exige que toda máquina cumpla requisitos de seguridad y lleve marcado CE antes de venderse o ponerse en marcha.',
    why: 'S-NFI es el fabricante de referencia (OEM) de los módulos. Sin declaración de conformidad y marcado CE no se pueden comercializar en la UE.',
    requirements: [
      'Determinar si cada módulo es una máquina y si figura en la lista de máquinas de alto riesgo, que exige organismo notificado.',
      'Aplicar los requisitos esenciales de seguridad y reunir el expediente técnico.',
      'Revisar los requisitos nuevos sobre software de seguridad y sistemas con comportamiento evolutivo, y contrastarlos con el texto legal.',
      'Redactar el manual de instrucciones y la Declaración UE de conformidad.',
      'Colocar el marcado CE.',
      'Evaluar con un organismo notificado qué otras directivas de producto aplican: baja tensión, compatibilidad electromagnética y equipos a presión.',
    ],
    references: [REF.machinery],
  },
  {
    id: 'iso-12100', code: 'ISO 12100', title: 'Seguridad de las máquinas: evaluación y reducción del riesgo', kind: 'iso', family: 'Seguridad y explosiones',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'media',
    summary: 'Método para identificar los peligros de una máquina y reducirlos desde el diseño.',
    why: 'Es la base técnica para cumplir el Reglamento de máquinas. S-NFI diseña los módulos y responde por la seguridad del diseño.',
    requirements: [
      'Evaluación de riesgos de cada módulo: BioGrinder, BioDeshidratador y el resto de la línea.',
      'Medidas de diseño: resguardos, paradas de emergencia y enclavamientos.',
      'Información de uso: manual, señalización y formación.',
      'Registro de los riesgos residuales.',
    ],
  },
  {
    id: 'iso-13849-1', code: 'ISO 13849-1', title: 'Seguridad de las máquinas: partes del control relacionadas con la seguridad', kind: 'iso', family: 'Seguridad y explosiones',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'media',
    summary: 'Define el nivel de fiabilidad (Performance Level) que deben tener las funciones de seguridad del sistema de control.',
    why: 'La Physical AI controla temperatura, torque y velocidad. Las funciones de seguridad, como paradas y límites, deben ser fiables aunque falle la capa de optimización.',
    requirements: [
      'Identificar las funciones de seguridad del control de cada módulo.',
      'Asignar a cada función el nivel de fiabilidad requerido.',
      'Validar con pruebas que se alcanza ese nivel.',
      'Mantener la lógica de seguridad separada de la capa de optimización de la IA.',
    ],
  },
  {
    id: 'atex-2014-34', code: 'Directiva 2014/34/UE', title: 'ATEX de producto: equipos para atmósferas explosivas', kind: 'ue', family: 'Seguridad y explosiones',
    jurisdictions: ['UE', 'ES'], nature: 'obligatoria', priority: 'alta',
    appliesWhen: 'Si un módulo o un componente va a funcionar en una zona con gas, vapor o polvo explosivo.',
    summary: 'Obliga al fabricante a que los equipos destinados a esas zonas estén diseñados, ensayados y marcados para ellas (marcado Ex además del CE). En España la recoge el Real Decreto 144/2016.',
    why: 'Triturar y secar residuo orgánico genera polvo combustible, y el aprovechamiento de gas natural previsto en Argelia añade atmósferas de gas. Todo módulo o componente que funcione dentro de una zona clasificada necesita la categoría ATEX adecuada: 1D, 2D o 3D para polvo y 1G, 2G o 3G para gas.',
    requirements: [
      'Caracterizar el polvo real en laboratorio: humedad, granulometría, energía mínima de ignición, temperatura de ignición de nube y de capa, Kst y Pmax.',
      'Gas natural: es sobre todo metano (grupo IIA, clase de temperatura T1). Confirmarlo con el análisis de composición del gas real, porque otros componentes pueden cambiar el grupo o la clase.',
      'Acordar con el cliente en qué zonas se instalará cada módulo (ver el Registro de zonas ATEX).',
      'Elegir la categoría del equipo según la zona: 1D, 2D y 3D en las zonas 20, 21 y 22 (polvo); 1G, 2G y 3G en las zonas 0, 1 y 2 (gas).',
      'Controlar las fuentes de ignición, con especial atención a la temperatura de superficie del deshidratador y a las chispas mecánicas.',
      'Evaluación de conformidad, con organismo notificado cuando el procedimiento lo exija.',
      'Expediente técnico, instrucciones, marcado CE y Ex, y Declaración UE de conformidad.',
    ],
    references: [REF.atex],
  },
  {
    id: 'atex-1999-92', code: 'Directiva 1999/92/CE', title: 'ATEX de lugares de trabajo: protección de los trabajadores', kind: 'ue', family: 'Seguridad y explosiones',
    jurisdictions: ['UE', 'ES'], nature: 'obligatoria', priority: 'alta',
    appliesWhen: 'Al empleador de cada instalación: S-NFI en sus propias plantas y el cliente en las suyas. Si comparten lugar de trabajo, deben coordinarse.',
    summary: 'Obliga a quien opera una instalación con posible atmósfera explosiva a evaluar el riesgo, clasificar las zonas y documentar las medidas de protección. En España la recoge el Real Decreto 681/2003.',
    why: 'Cada nodo trabaja con polvo orgánico y, donde se aproveche gas natural, con atmósferas de gas. Aunque la obligación sea del operador, S-NFI debe entregar los datos del polvo, del gas y de los equipos para que el cliente pueda cumplirla en Navarra, Gipuzkoa o Argelia.',
    requirements: [
      'Evaluar el riesgo de explosión de cada puesto y de cada módulo.',
      'Clasificar las zonas (0, 1 y 2 para gas; 20, 21 y 22 para polvo) en el Registro de zonas ATEX.',
      'Redactar el documento de protección contra explosiones.',
      'Medidas técnicas y organizativas: limpieza del polvo acumulado, ventilación y control de fuentes de ignición.',
      'Señalizar las zonas con el panel de advertencia de atmósferas explosivas.',
      'Formar a los trabajadores y revisar antes de la puesta en servicio y tras cada modificación.',
      'Coordinar con la empresa cliente cuando comparten el lugar de trabajo.',
    ],
    references: [REF.atex],
  },
  {
    id: 'iso-80079', code: 'ISO 80079-36 / -37', title: 'Equipos no eléctricos para atmósferas explosivas', kind: 'iso', family: 'Seguridad y explosiones',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'media',
    summary: 'Requisitos y tipos de protección para equipos mecánicos, como trituradoras, transportadores y rodamientos, que trabajen donde pueda haber atmósfera explosiva.',
    why: 'El BioGrinder y las partes mecánicas del deshidratador no son equipos eléctricos. Estas normas indican cómo evitar que generen chispas o superficies calientes capaces de inflamar el polvo.',
    requirements: [
      'Análisis de fuentes de ignición de cada módulo: superficies calientes, chispas mecánicas, fricción y electricidad estática.',
      'Mantener la temperatura de las superficies por debajo de la temperatura de ignición del polvo.',
      'Elegir el tipo de protección adecuado para cada fuente de ignición que no se pueda eliminar.',
      'Reunir la documentación técnica para el marcado ATEX.',
    ],
  },

  {
    id: 'ped-2014-68', code: 'Directiva 2014/68/UE', title: 'Equipos a presión (marcado CE)', kind: 'ue', family: 'Seguridad y explosiones',
    jurisdictions: ['UE', 'ES'], nature: 'obligatoria', priority: 'media',
    appliesWhen: 'Si un equipo o conjunto contiene fluidos, como gas o vapor, a una presión máxima admisible superior a 0,5 bar.',
    summary: 'Ley europea sobre el diseño, la fabricación y la evaluación de conformidad de equipos a presión: recipientes, tuberías y accesorios de seguridad. Los clasifica en categorías de I a IV según el riesgo.',
    why: 'El aprovechamiento de gas natural previsto en Argelia puede introducir recipientes y tuberías a presión en la instalación. Si superan el umbral, necesitan marcado CE y, desde la categoría II, un organismo notificado.',
    requirements: [
      'Inventariar los recipientes, tuberías y accesorios de seguridad de cada módulo y de la instalación de gas, con su presión máxima admisible.',
      'Clasificar cada equipo en su categoría (I a IV) según la presión, el volumen y el tipo de fluido.',
      'Evaluación de conformidad: control interno de producción en la categoría I y organismo notificado desde la II.',
      'Expediente técnico, instrucciones, marcado CE y Declaración UE de conformidad.',
      'Dejar constancia de los equipos que quedan por debajo de la categoría I: se diseñan con buenas prácticas de ingeniería y no llevan marcado CE.',
    ],
  },

  /* ---- Aduanas y carbono ---- */
  {
    id: 'cbam', code: 'Reglamento (UE) 2023/956', title: 'CBAM · Mecanismo de ajuste en frontera por carbono', kind: 'ue', family: 'Aduanas y carbono',
    jurisdictions: ['UE', 'DZ'], nature: 'indirecta', priority: 'alta',
    appliesWhen: 'No obliga directamente a S-NFI, porque sus productos no están en el ámbito. Afecta a los clientes industriales que exporten a la UE cemento, hierro y acero, aluminio, fertilizantes, electricidad o hidrógeno, como los de Argelia.',
    summary: 'Reglamento europeo (no directiva) que hace pagar al importador el carbono emitido al fabricar ciertos productos fuera de la UE. Régimen definitivo desde el 1 de enero de 2026.',
    why: 'El despliegue previsto en Argelia sitúa a S-NFI ante industrias que exportan a la UE. Si el biopellet sustituye combustible fósil y cumple los criterios de sostenibilidad, puede reducir las emisiones incorporadas de su cliente y, con ello, su coste CBAM.',
    requirements: [
      'Identificar qué clientes potenciales de Argelia exportan a la UE bienes CBAM: fertilizantes, hierro y acero, cemento u otros.',
      'Estimar la exposición de cada cliente con el simulador de esta página.',
      'Definir qué datos de emisiones aporta el módulo (energía térmica sustituida, trazabilidad por lote) para la declaración del cliente.',
      'Comprobar si el biopellet cumple los criterios de sostenibilidad de la Directiva (UE) 2018/2001. Sin ellos, la Comisión no lo contabiliza con factor cero cuando se usa como combustible.',
      'Acordar con un verificador acreditado el método de cálculo y la verificación de las emisiones.',
      'Revisar con el asesor aduanero del cliente el umbral de 50 toneladas netas al año y el calendario.',
    ],
    references: [REF.cbamPage, REF.cbamGuidance, REF.cbamQa, REF.sandbag],
  },
  {
    id: 'eu-red', code: 'Directiva (UE) 2018/2001', title: 'RED · criterios de sostenibilidad de la biomasa', kind: 'ue', family: 'Aduanas y carbono',
    jurisdictions: ['UE'], nature: 'indirecta', priority: 'media',
    appliesWhen: 'Cuando el biopellet se usa como combustible y se quiere contar como renovable, por ejemplo en la declaración CBAM de un cliente.',
    summary: 'Define cuándo la biomasa usada como combustible cuenta como renovable: criterios de sostenibilidad y de ahorro de gases de efecto invernadero. Modificada por la Directiva (UE) 2023/2413.',
    why: 'Según la Comisión Europea, la biomasa usada como combustible solo se contabiliza con factor de emisión cero en CBAM si cumple estos criterios. Es la llave técnica de la ventaja de S-NFI frente al CBAM.',
    requirements: [
      'Determinar si el residuo de entrada es residuo, subproducto o biomasa agrícola, porque los criterios cambian según el tipo.',
      'Montar la cadena de custodia desde el origen del residuo hasta el cliente.',
      'Valorar un esquema de certificación voluntario reconocido por la Comisión, por ejemplo ISCC.',
      'Calcular el ahorro de emisiones del biopellet frente al combustible fósil que sustituye.',
      'Confirmar con el verificador del cliente que aceptará esta evidencia en su declaración CBAM.',
    ],
    references: [REF.cbamQa],
  },

  /* ---- Integridad ---- */
  {
    id: 'iso-37001', code: 'ISO 37001', title: 'Sistemas de gestión antisoborno', kind: 'iso', family: 'Integridad',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'media',
    summary: 'Sistema certificable para prevenir, detectar y gestionar el soborno.',
    why: 'La entrada en mercados nuevos, como Argelia, implica intermediarios, licencias y aduanas. Refuerza la doctrina de cumplimiento de Pactvm Viridi.',
    requirements: [
      'Evaluar el riesgo de soborno por país y por tipo de tercero.',
      'Política antisoborno y canal de denuncias.',
      'Diligencia debida sobre agentes, socios e intermediarios.',
      'Formación y auditoría.',
    ],
  },
  {
    id: 'iso-37301', code: 'ISO 37301', title: 'Sistemas de gestión de compliance', kind: 'iso', family: 'Integridad',
    jurisdictions: ['INT'], nature: 'voluntaria', priority: 'vigilar',
    summary: 'Marco certificable para organizar el cumplimiento de todas las obligaciones legales de la empresa.',
    why: 'Es el paraguas de lo que gestiona Herzog LaW: ordena quién cumple qué, con qué evidencia y con qué revisión.',
    requirements: [
      'Registro único de obligaciones con responsable y fecha, que es lo que mantiene este módulo.',
      'Revisión periódica por la Dirección.',
      'Canal para comunicar incumplimientos.',
    ],
  },

  /* ---- Argelia ---- */
  {
    id: 'dz-marco-local', code: 'Argelia · marco local', title: 'Marco legal y normativo de Argelia', kind: 'local', family: 'Argelia',
    jurisdictions: ['DZ'], nature: 'obligatoria', priority: 'alta',
    appliesWhen: 'Al implantar y operar nodos en Argelia. El contenido exacto debe confirmarlo un asesor jurídico local.',
    summary: 'Normativa propia de Argelia que se suma a la europea: permisos de implantación, seguridad industrial, atmósferas explosivas, aprovechamiento de gas natural, importación de maquinaria y comercio del biocombustible. Pendiente de validar con asesoría local.',
    why: 'Es probable que S-NFI despliegue en Argelia. Hasta confirmarlo con un asesor local, no se debe dar por cierto ningún requisito.',
    requirements: [
      'Contratar un asesor jurídico y técnico local.',
      'Confirmar la autoridad competente y los permisos necesarios para implantar una instalación industrial.',
      'Consultar al IANOR, el instituto de normalización argelino, qué normas ISO ha adoptado y cuáles son obligatorias.',
      'Identificar la normativa argelina sobre atmósferas explosivas, equipos a presión y seguridad de los trabajadores, incluida la del sector de hidrocarburos. La ficha ATEX del IANOR cita los decretos ejecutivos 21-261 (equipos a presión y eléctricos de instalaciones de hidrocarburos) y 01-342 (protección de los trabajadores frente a riesgos eléctricos), a confirmar en el Diario Oficial.',
      'Confirmar si Argelia reconoce el marcado CE y los certificados ATEX europeos o exige ensayos locales.',
      'Confirmar el régimen de importación de maquinaria y de exportación del biopellet.',
      'Confirmar el régimen legal del aprovechamiento de gas natural: permisos, titularidad del gas y autoridad competente, incluida la normativa del sector de hidrocarburos.',
      'Revisar los tratados de inversión y la fiscalidad aplicables.',
    ],
    references: [REF.ianorAtex],
  },
];

/**
 * Titulos concedidos que Marc confirmo que S-NFI ya tiene, sin numeros ni fechas.
 * Solo se siembran en el tenant por defecto (los datos son de S-NFI) y una unica
 * vez: despues se editan y se borran como cualquier marco propio.
 */
export const TITLE_SEED = [
  {
    id: 'titulo-pyme-innovadora', code: 'Sello PYME Innovadora', title: 'Sello de Pyme Innovadora', kind: 'titulo', family: 'Títulos del Estado',
    jurisdictions: ['ES'], nature: 'voluntaria', priority: 'media', status: 'vigente', tracksExpiry: true,
    issuer: 'Ministerio de Ciencia, Innovación y Universidades',
    summary: 'Sello público que reconoce a una pyme como innovadora y la inscribe en el registro de pymes innovadoras. Da acceso a incentivos fiscales y a la compra pública de innovación.',
    why: 'Respalda ante clientes, administraciones y financiadores el carácter tecnológico de S-NFI y abre incentivos fiscales y la compra pública de innovación.',
    requirements: [
      'Registrar la fecha de inscripción y la de vencimiento: el sello dura tres años desde la inscripción, según las fuentes consultadas. Confirmarlo en el Ministerio.',
      'Guardar el certificado y el número de registro en Documentos.',
      'Preparar la renovación antes del vencimiento: si no se renueva a tiempo, la empresa causa baja en el registro.',
      'Comprobar que siguen cumpliéndose los requisitos del sello: si dejan de cumplirse, se puede perder.',
      'Anotar las ventajas que se están usando: deducciones por I+D+i, bonificaciones y compra pública de innovación.',
    ],
    references: [REF.pymeInnovadora],
  },
  {
    id: 'titulo-modelo-utilidad', code: 'Modelo de utilidad', title: 'Modelo de utilidad (propiedad industrial)', kind: 'titulo', family: 'Títulos del Estado',
    jurisdictions: ['ES'], nature: 'voluntaria', priority: 'media', status: 'vigente', tracksExpiry: true,
    issuer: 'Oficina Española de Patentes y Marcas (OEPM)',
    summary: 'Título de propiedad industrial que protege una invención durante diez años desde la presentación de la solicitud. No es prorrogable y exige pagar una tasa anual a partir del tercer año.',
    why: 'Forma parte de los activos de propiedad intelectual de S-NFI. Si no se pagan las tasas, el modelo caduca y cualquiera puede explotar la invención.',
    requirements: [
      'Registrar el número de solicitud, la fecha de presentación y la de vencimiento (diez años desde la presentación).',
      'Pagar la tasa anual a partir del tercer año y guardar los justificantes en Documentos.',
      'Guardar el título en Documentos.',
      'Valorar con un agente de la propiedad industrial la protección en otros países, como Argelia, antes del despliegue: el título español solo protege en España.',
    ],
    references: [REF.oepm, REF.modeloUtilidad],
  },
  {
    id: 'titulo-camara-espana-emprende', code: 'Cámara de Comercio · España Emprende', title: 'Adhesión a la Cámara de Comercio (España Emprende)', kind: 'titulo', family: 'Títulos del Estado',
    jurisdictions: ['ES'], nature: 'voluntaria', priority: 'vigilar', status: 'vigente', tracksExpiry: false,
    issuer: 'Cámara de Comercio de España',
    summary: 'Programa de la Cámara de España, ejecutado por la red de Cámaras de Comercio y cofinanciado por el Fondo Social Europeo, que apoya la creación y consolidación de empresas.',
    why: 'Da acceso a información, asesoramiento y apoyo empresarial de la red de Cámaras.',
    requirements: [
      'Registrar la Cámara a la que está adherida S-NFI y la fecha de adhesión.',
      'Guardar el justificante de la adhesión en Documentos.',
      'Confirmar con la Cámara si la adhesión caduca o necesita renovarse.',
    ],
    references: [REF.espanaEmprende],
  },
];

/* ---- CBAM: datos publicos de la Comision Europea ---- */

export const CBAM_REFERENCE = {
  sectors: ['Cemento', 'Hierro y acero', 'Aluminio', 'Fertilizantes', 'Electricidad', 'Hidrógeno'],
  thresholdTonnes: 50,
  /* Porcentaje de la asignacion gratuita que se retira cada ano. */
  factorByYear: [
    { year: 2026, pct: 2.5 }, { year: 2027, pct: 5 }, { year: 2028, pct: 10 }, { year: 2029, pct: 22.5 },
    { year: 2030, pct: 48.5 }, { year: 2031, pct: 61 }, { year: 2032, pct: 73.5 }, { year: 2033, pct: 86 }, { year: 2034, pct: 100 },
  ],
  timeline: [
    { date: '2023-10-01', label: 'Periodo transitorio', detail: 'Solo hay que declarar las emisiones de las importaciones.' },
    { date: '2026-01-01', label: 'Régimen definitivo', detail: 'Empieza a aplicarse el coste. Umbral de 50 toneladas netas al año por importador.' },
    { date: '2027-02-01', label: 'Venta de certificados', detail: 'Se compran los certificados de las importaciones de 2026.' },
    { date: '2027-09-30', label: 'Primera entrega', detail: 'Se entregan los certificados de las importaciones de 2026.' },
    { date: '2034-01-01', label: 'Sin asignación gratuita', detail: 'La retirada de la asignación gratuita llega al 100 %.' },
  ],
  algeria: {
    note: 'Según Sandbag (febrero de 2026), los bienes CBAM son cerca del 2,7 % de las exportaciones argelinas a la UE. La exposición se concentra en fertilizantes y en hierro y acero.',
    sources: [REF.sandbag],
  },
  biomass: 'Según la Comisión, la biomasa usada como combustible solo se contabiliza con factor de emisión cero si cumple los criterios de sostenibilidad de la Directiva (UE) 2018/2001.',
  sources: [REF.cbamPage, REF.cbamGuidance, REF.cbamQa],
};

/* ---- ATEX: definicion de zonas ---- */

export const ZONE_REFERENCE = {
  polvo: [
    { zone: '20', category: '1D', meaning: 'Nube de polvo combustible presente de forma continua o durante largos periodos.' },
    { zone: '21', category: '2D', meaning: 'Es probable que aparezca de forma ocasional en funcionamiento normal.' },
    { zone: '22', category: '3D', meaning: 'No es probable en funcionamiento normal y, si aparece, dura poco.' },
  ],
  gas: [
    { zone: '0', category: '1G', meaning: 'Atmósfera de gas o vapor presente de forma continua o durante largos periodos.' },
    { zone: '1', category: '2G', meaning: 'Es probable que aparezca de forma ocasional en funcionamiento normal.' },
    { zone: '2', category: '3G', meaning: 'No es probable en funcionamiento normal y, si aparece, dura poco.' },
  ],
};
