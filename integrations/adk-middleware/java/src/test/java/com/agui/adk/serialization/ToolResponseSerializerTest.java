package com.agui.adk.serialization;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ToolResponseSerializerTest {

    @Test
    void decodesBytesToUtf8() {
        assertThat(ToolResponseSerializer.serialize(new byte[]{'h', 'i'})).isEqualTo("\"hi\"");
    }

    @Test
    void keepsNonAsciiVerbatimInsteadOfEscaping() {
        assertThat(ToolResponseSerializer.serialize(Map.of("city", "Paris — été")))
                .contains("Paris — été");
    }

    @Test
    void guardsAgainstReferenceCycles() {
        Map<String, Object> a = new LinkedHashMap<>();
        Map<String, Object> b = new LinkedHashMap<>();
        a.put("b", b);
        b.put("a", a);
        String json = ToolResponseSerializer.serialize(a);
        assertThat(json).isNotBlank();
    }

    @Test
    void coercesArbitraryObjectsViaPublicFields() {
        class Payload {
            @SuppressWarnings("unused") public String name = "x";
            @SuppressWarnings("unused") public int count = 3;
        }
        assertThat(ToolResponseSerializer.serialize(new Payload()))
                .contains("\"name\":\"x\"", "\"count\":3");
    }

    @Test
    void mapsAndListsCoerceNested() {
        assertThat(ToolResponseSerializer.serialize(Map.of("k", List.of(1, 2, 3))))
                .isEqualTo("{\"k\":[1,2,3]}");
    }

    @Test
    void selfReferentialPojoUsesItsStringRepresentationForTheRepeatedIdentity() {
        class Payload {
            @SuppressWarnings("unused") public Object self;

            Payload() {
                self = this;
            }

            @Override
            public String toString() {
                return "self-reference";
            }
        }

        assertThat(ToolResponseSerializer.serialize(new Payload()))
                .isEqualTo("{\"self\":\"self-reference\"}");
    }

    @Test
    void includesInheritedFieldsWithChildOverridesWinning() {
        class ParentPayload {
            @SuppressWarnings("unused") public String inherited = "parent";
            @SuppressWarnings("unused") public String shared = "parent";
        }
        class ChildPayload extends ParentPayload {
            @SuppressWarnings("unused") public String own = "child";
            @SuppressWarnings("unused") public String shared = "child";
        }

        assertThat(ToolResponseSerializer.serialize(new ChildPayload()))
                .isEqualTo("{\"own\":\"child\",\"shared\":\"child\",\"inherited\":\"parent\"}");
    }

    @Test
    void dumpMethodTakesPrecedenceOverIterableBehavior() {
        class DumpableIterable implements Iterable<String> {
            public Map<String, Object> toMap() {
                return Map.of("source", "dump");
            }

            @Override
            public Iterator<String> iterator() {
                return List.of("iterable").iterator();
            }
        }

        assertThat(ToolResponseSerializer.serialize(new DumpableIterable()))
                .isEqualTo("{\"source\":\"dump\"}");
    }

    @Test
    void ultimateFallbackReturnsAValidJsonEmptyString() {
        Object unstringifiable = new Object() {
            @Override
            public String toString() {
                throw new IllegalStateException("cannot stringify");
            }
        };

        assertThat(ToolResponseSerializer.serialize(unstringifiable)).isEqualTo("\"\"");
    }

    @Test
    void malformedUtf8FallsBackToUnsignedIntegerList() {
        assertThat(ToolResponseSerializer.serialize(new byte[]{(byte) 0xC3, 0x28, (byte) 0xFF}))
                .isEqualTo("[195,40,255]");
    }
}
