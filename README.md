# Portal Imperial — Sistema POS (con sincronización Firebase)

Sistema de punto de venta web. Ahora SINCRONIZA en tiempo real entre todos los
dispositivos (caja, cocina, meseros) usando Firebase Realtime Database.

## Archivos
- index.html          → página principal
- app.js              → lógica del sistema
- firebase-config.js  → llaves de TU base de datos Firebase
- render.yaml, package.json, .gitignore → configuración de publicación

## Usuarios de prueba
- admin / admin123       (administrador)
- cajero1 / caja123      (cajero)
- cocina / cocina123     (pantalla de cocina)

## IMPORTANTE: Reglas de seguridad de Firebase
En la consola de Firebase → Realtime Database → pestaña "Reglas", pega esto
para que solo funcione desde tu app (y cambia el modo de prueba):

{
  "rules": {
    "data": {
      ".read": true,
      ".write": true
    }
  }
}

Esto permite leer/escribir los datos del restaurante. Para mayor seguridad más
adelante se puede añadir autenticación de Firebase.
