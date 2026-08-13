package com.agui.adk.hitl;

import com.agui.community.core.message.ToolMessage;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;

class ToolResultNormalizerTest {
    private final ToolResultNormalizer normalizer = new ToolResultNormalizer();

    @Test
    void preservesEverySupportedFrontendResultFormLosslessly() {
        assertEquals(Map.of("answer", 1), normalizer.normalize(message("{\"answer\":1}")).response());
        assertEquals(List.of("a", 2), normalizer.normalize(message("[\"a\",2]")).response().get("result"));
        assertEquals("text", normalizer.normalize(message("\"text\"")).response().get("result"));
        assertEquals(42, normalizer.normalize(message("42")).response().get("result"));
        assertEquals(true, normalizer.normalize(message("true")).response().get("result"));
        assertNull(normalizer.normalize(message("null")).response().get("result"));
        assertEquals("", normalizer.normalize(message("")).response().get("result"));
        assertEquals("{not-json", normalizer.normalize(message("{not-json")).response().get("result"));
        assertEquals("browser failed", normalizer.normalize(new ToolMessage("m", "ignored", "call", "browser failed"))
                .response().get("error"));
    }

    @Test
    void preservesRootHighPrecisionDecimalExactly() {
        Object result = normalizer.normalize(message("1234567890.123456789012345678901234567890")).response().get("result");

        assertInstanceOf(BigDecimal.class, result);
        assertEquals(new BigDecimal("1234567890.123456789012345678901234567890"), result);
    }

    @Test
    void preservesNestedHighPrecisionDecimalExactly() {
        Object result = normalizer.normalize(message("{\"nested\":[{\"amount\":1234567890.123456789012345678901234567890}]}"))
                .response().get("nested");

        Object amount = ((Map<?, ?>) ((List<?>) result).getFirst()).get("amount");
        assertInstanceOf(BigDecimal.class, amount);
        assertEquals(new BigDecimal("1234567890.123456789012345678901234567890"), amount);
    }

    @Test
    void preservesRootIntegerBeyondLongExactly() {
        Object result = normalizer.normalize(message("92233720368547758081234567890")).response().get("result");

        assertInstanceOf(BigInteger.class, result);
        assertEquals(new BigInteger("92233720368547758081234567890"), result);
    }

    @Test
    void preservesNestedIntegerBeyondLongExactly() {
        Object result = normalizer.normalize(message("{\"nested\":[92233720368547758081234567890]}"))
                .response().get("nested");

        Object number = ((List<?>) result).getFirst();
        assertInstanceOf(BigInteger.class, number);
        assertEquals(new BigInteger("92233720368547758081234567890"), number);
    }

    @Test
    void retainsOriginalCallAndToolIdentityForFunctionResponse() {
        NormalizedToolResult result = normalizer.normalize(message("{\"ok\":true}"));
        assertEquals("call", result.toolCallId());
        assertInstanceOf(Map.class, result.response());
    }

    private static ToolMessage message(String content) {
        return new ToolMessage("m", content, "call");
    }
}
