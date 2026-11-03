# Encargo para el agente de la API: integridad y seguridad antes de la primera versión

## Contexto y límites

- Repositorio: `Juntos API` (`https://github.com/NirvanSoul/JuntosRebirthAPI`). La app está en `Juntos Rebirth`. Lee las instrucciones y la documentación aplicables de ambos proyectos antes de cambiar contratos.
- El 1 de noviembre de 2026, la copia local de la API tenía cambios sin confirmar, incluidas las migraciones `0033` y `0034`. La app también tenía cambios en curso. Inspecciona y conserva todo el trabajo existente; no lo descartes ni supongas que las líneas siguen siendo iguales.
- Los escenarios siguientes se dedujeron del código; no se reprodujeron contra PostgreSQL real. Reproduce cada defecto con datos ficticios y una prueba que falle antes de corregirlo. No afirmes que producción está afectada sin verificar la versión desplegada y su esquema.
- Coordina con el agente de la app usando `patch/APP.md`. Los cambios de contrato requieren compatibilidad con clientes existentes y actualización de la documentación. No despliegues ni ejecutes migraciones en producción como parte de esta indicación.

## 1. Bloqueante: resolución de conflictos de filas y sus datos asociados

En `src/services/space-sync.ts`, el `ON CONFLICT ... setWhere` de la categoría, cuenta o transacción solo acepta una versión con `updatedAt` igual o posterior. Sin embargo, el lote también borra e inserta sus presupuestos, saldos o tasas históricas sin condicionar esas operaciones al resultado del conflicto de la fila principal. La respuesta de transacciones se construye con lo recibido aunque el servidor no haya aplicado esa versión. El cliente, además, marca filas enviadas como sincronizadas al recibir éxito.

Reproducción mínima: crear una cuenta con saldo 200 y fecha T2; enviar una versión T1 anterior con saldo 100 y el mismo identificador remoto; comprobar que el padre queda en T2 pero el saldo puede pasar a 100. Repetir con presupuesto y con una transacción VE cuya cantidad y tasas históricas cambien. Añadir el caso de dos peticiones concurrentes, no solo peticiones secuenciales.

**Resultado exigido:** la decisión de aceptar o rechazar cada versión y la escritura de todas sus filas hijas deben ser atómicas frente a otras peticiones. Una versión descartada no puede borrar ni sustituir hijos, ni devolver sus valores como si fueran canónicos. Las actualizaciones aceptadas deben reflejarse en el cursor incremental para que los otros dispositivos reciban el estado correcto. Mantener la validación de espacio y la idempotencia de reintentos. La decisión no puede depender únicamente de una lectura previa fuera de la escritura atómica.

Coordina explícitamente cómo informar al cliente de versiones descartadas y devolver o recuperar el estado canónico; no cambies silenciosamente el significado de una respuesta exitosa para versiones anteriores de la app. Prueba versiones anterior, igual y posterior, reintento tras respuesta perdida, inserción inicial, restricciones de espacio y concurrencia. Ejecuta esas pruebas con PostgreSQL real aislado, además de pruebas unitarias.

## 2. Compatibilidad de presupuestos y migraciones

La app envía `period`, `intervalDays`, `anchorOn`, `overrides` e `history` en presupuestos. La rama `origin/main` revisada (`b67e68efef170f31d07e21a84f68f9f0732ab97d`) guardaba moneda e importe, pero no esos campos. La copia local contiene implementación y migraciones aún sin confirmar; esto no demuestra qué está desplegado.

- Verifica que escritura, snapshot y delta preservan todos los campos y que clientes antiguos siguen funcionando. Comprueba que las migraciones pendientes y el journal son coherentes y se aplican en orden.
- Reproduce creación, edición, cambio de periodicidad, excepciones e historial; restaura en otro dispositivo y compara el resultado. Incluye presupuestos por varias monedas y la resolución de conflictos del punto 1.
- Antes de cualquier publicación, compara de forma segura la versión desplegada y sus migraciones con el contrato de la app. Documenta el orden de migración y despliegue, compatibilidad y plan de recuperación sin borrar datos. La auditoría no comprobó producción.

## 3. Logs y protección operativa

`src/routes/health.ts` registra el error de conexión completo y `src/routes/sync.ts` imprime `message`, `detail`, `hint` y `where` del error de base de datos. Esos campos podrían incluir valores sensibles. Revisa también otros registros equivalentes: conserva código, categoría y correlación útiles, pero evita cuerpos, filas, credenciales, cookies, tokens y datos personales. Prueba con errores ficticios que contengan secretos y datos financieros, comprobando tanto logs como respuestas. Revisa controles de acceso y retención de logs existentes sin exponer su contenido.

## 4. Seguridad del entorno de pruebas

`vitest.integration.config.ts` recurre a `DATABASE_URL` de `.dev.vars` si no existe `DATABASE_URL_TEST`. Además, `test/integration/harness.ts` elimina todos los agregados de comercios sin votos, no únicamente los creados por la prueba. Antes de ejecutar integración, verifica que la base es expresamente aislada y desechable; no uses producción ni una URL de procedencia desconocida. Corrige el arnés para impedir el fallback inseguro y limitar la limpieza a datos de prueba; añade salvaguardas verificables y pruebas correspondientes.

## Entrega y verificaciones

- Ejecuta `npm run typecheck`, `npm test` e integración en PostgreSQL aislado. Aporta comandos, salida y códigos reales; identifica cualquier prueba que no pudo ejecutarse.
- Demuestra el fallo anterior y la corrección con pruebas proporcionales, incluyendo dos usuarios, dos espacios, versiones en conflicto y concurrencia. No uses datos personales reales.
- Actualiza documentación de contratos, migraciones y despliegue cuando corresponda. Entrega cambios por unidades revisables, riesgos restantes y coordinación requerida con la app. Respeta los gates de revisión aplicables.
