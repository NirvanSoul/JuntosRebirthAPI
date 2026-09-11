# Expulsión de espacios compartidos al cambiar de país

Desplegado el 9 de septiembre de 2026, verificado a las 00:58 Europe/Madrid.
Worker: `7149d50a-1dc1-4ba9-b610-41177b59c55f`.

## Fallo y corrección

El cambio de país creaba/activaba el contexto personal, pero dejaba activas las
membresías compartidas. La ruta devolvía siempre `leftSharedSpaceIds: []` y los
filtros de acceso trataban un perfil sin país como compatible con cualquier país.

Ahora las membresías incompatibles pasan a `left`, con fecha de salida, en la
misma transacción que cambia el país. La respuesta comunica sus IDs. Listados,
snapshot y autorización exigen igualdad de país, incluido NULL con NULL. Volver
al país anterior no reactiva la membresía; aceptar una nueva invitación sí puede.

Si sale el último propietario, se promueve un miembro compatible, priorizando
administradores y después antigüedad. Si no queda ninguno, se archiva el espacio.
Se revocan invitaciones pendientes emitidas por quien sale en esos espacios.
Se libera su referencia `spaces.created_by` para que el índice de pareja no le
impida crear otro espacio; la autoría de movimientos y categorías se conserva.
Los contextos personales anteriores siguen disponibles al volver a su país.

La migración `0025_leave_shared_spaces_on_country_change` instala triggers para
aplicar la baja y bloquear reactivaciones incompatibles. El trigger AFTER de
perfil ve el cambio completado en su transacción, conforme a las reglas de
[visibilidad de PostgreSQL](https://www.postgresql.org/docs/16/trigger-datachanges.html).

## Reparación de producción

Antes: una membresía `active` de un usuario `VE` en un espacio compartido con
`country_code = NULL`; el propietario también tenía país NULL.

Después: esa membresía está `left`; el propietario sigue `active`. Consulta de
incompatibilidades activas tras migrar: `count = 0`. No se borró historial.

La migración quedó registrada como ID 26 en `drizzle.__drizzle_migrations` y su
SHA-256 coincide con el archivo. Se ejecutaron `npm run db:migrate:production`
y `npm run deploy:production`; este último volvió a confirmar las migraciones
antes de publicar. La migración se validó primero en un esquema temporal aislado.

## Verificación

- Typecheck: exit 0.
- Suite unitaria: 32 archivos, 255 tests aprobados.
- Integración Neon: 7 tests aprobados entre `country-membership.test.ts` y
  `bootstrap-schema.test.ts`. Incluyen propietario, miembro, pareja, otros espacios,
  país NULL, salida del último miembro, regreso de país, nueva invitación y bloqueo
  de una reactivación incompatible.
- Se actualizaron las expectativas antiguas de bloqueo de país en
  `members-invitations.test.ts`; no se ejecutó ese archivo completo en esta sesión.

Prueba HTTP con dos usuarios temporales autenticados y verificados, ambos ES:

| Operación | Resultado | CF-Ray |
| --- | --- | --- |
| Leer miembros antes del cambio | 200 | `a3818e84b9880431-MAD` |
| Cambiar miembro a VE | 200 y `leftSharedSpaceIds` con el espacio | `a3818e85da650431-MAD` |
| Listar espacios tras salir | 200, espacio excluido | `a3818e87dbaa0431-MAD` |
| Snapshot tras salir | 200, espacio excluido | `a3818e88bc3e0431-MAD` |
| Leer miembros después de salir | 404 `SPACE_NOT_FOUND` | `a3818e8a1d380431-MAD` |
| Sincronizar el espacio después de salir | 404 `SPACE_NOT_FOUND` | `a3818e8afdd50431-MAD` |
| Leer miembros como propietario que permanece | 200, un miembro | `a3818e8bde9b0431-MAD` |
| Leer tras volver a ES | 404 `SPACE_NOT_FOUND` | `a3818e8e58d10431-MAD` |
| `/health/db` | 200 `{"status":"ok","database":"connected"}` | `a3818e911b50ae92-MAD` |

Las fixtures temporales se eliminaron al terminar. No se modificó el frontend.
La retirada visual de datos que el dispositivo ya hubiera descargado depende de
que procese la respuesta del cambio de país o la próxima restauración/sincronización;
el servidor ya no entrega ni acepta cambios de ese espacio al usuario expulsado.
