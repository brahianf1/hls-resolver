#!/bin/bash
# Script de prueba para la funcionalidad anti-devtool

# Colores para output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Configuración
API_URL="http://localhost:8080"
API_KEY="dev-api-key"
TEST_URL="https://lamovie.link/embed-9g7p0nlgflbs.html"

echo -e "${YELLOW}🛡️  Testing Anti-Devtool Protection${NC}"
echo "======================================"
echo ""

# Verificar que el servicio esté corriendo
echo -e "${YELLOW}Verificando que el servicio esté activo...${NC}"
if ! curl -s "${API_URL}/health" > /dev/null; then
    echo -e "${RED}❌ Error: El servicio no está activo en ${API_URL}${NC}"
    echo "Por favor, ejecuta 'npm run dev' primero"
    exit 1
fi
echo -e "${GREEN}✓ Servicio activo${NC}"
echo ""

# Test 1: Endpoint protegido específico
echo -e "${YELLOW}Test 1: Endpoint /api/v1/resolve/protected${NC}"
echo "URL de prueba: ${TEST_URL}"
echo ""

RESPONSE=$(curl -s -X POST "${API_URL}/api/v1/resolve/protected" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${API_KEY}" \
  -d "{\"url\": \"${TEST_URL}\"}" \
  2>&1)

if [ $? -eq 0 ]; then
    # Parsear respuesta
    SUCCESS=$(echo "$RESPONSE" | grep -o '"success":[^,}]*' | grep -o '[^:]*$' | tr -d ' ')
    MANIFESTS_COUNT=$(echo "$RESPONSE" | grep -o '"manifests":\[' | wc -l)
    
    if [ "$SUCCESS" = "true" ]; then
        echo -e "${GREEN}✓ Test exitoso!${NC}"
        echo ""
        echo "Respuesta:"
        echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
    else
        echo -e "${RED}❌ Test falló - success: false${NC}"
        echo "Respuesta:"
        echo "$RESPONSE"
    fi
else
    echo -e "${RED}❌ Error en la petición${NC}"
    echo "$RESPONSE"
fi

echo ""
echo "======================================"
echo ""

# Test 2: Endpoint regular (detección automática)
echo -e "${YELLOW}Test 2: Endpoint /api/v1/resolve (detección automática)${NC}"
echo "URL de prueba: ${TEST_URL}"
echo ""

RESPONSE2=$(curl -s -X POST "${API_URL}/api/v1/resolve" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${API_KEY}" \
  -d "{\"url\": \"${TEST_URL}\", \"options\": {}}" \
  2>&1)

if [ $? -eq 0 ]; then
    STREAMS_COUNT=$(echo "$RESPONSE2" | grep -o '"streams":\[' | wc -l)
    
    if [ "$STREAMS_COUNT" -gt 0 ]; then
        echo -e "${GREEN}✓ Detección automática funcionando!${NC}"
        echo ""
        echo "Respuesta (primeras líneas):"
        echo "$RESPONSE2" | head -n 50
    else
        echo -e "${YELLOW}⚠️  No se detectaron streams${NC}"
        echo "Respuesta:"
        echo "$RESPONSE2"
    fi
else
    echo -e "${RED}❌ Error en la petición${NC}"
    echo "$RESPONSE2"
fi

echo ""
echo "======================================"
echo -e "${YELLOW}📋 Comandos útiles para debugging:${NC}"
echo ""
echo "1. Ver logs en tiempo real:"
echo "   npm run dev | grep -E '(Anti-devtool|HLS)'"
echo ""
echo "2. Ver solo detecciones HLS:"
echo "   npm run dev | grep '⭐ HLS'"
echo ""
echo "3. Verificar bloqueo de scripts:"
echo "   npm run dev | grep 'Anti-devtool script blocked'"
echo ""
echo "4. Ver guía completa:"
echo "   cat ANTI_DEVTOOL_TESTING.md"
echo ""

