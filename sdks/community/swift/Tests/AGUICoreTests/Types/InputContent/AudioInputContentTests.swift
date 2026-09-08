// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class AudioInputContentTests: XCTestCase {

    // MARK: - Initialization

    func test_initWithURL_setsFields() {
        let content = AudioInputContent(url: "https://example.com/audio.mp3")
        XCTAssertEqual(content.type, "audio")
        XCTAssertEqual(content.url, "https://example.com/audio.mp3")
        XCTAssertNil(content.data)
        XCTAssertNil(content.format)
    }

    func test_initWithData_setsFields() {
        let content = AudioInputContent(data: "base64audio", format: "mp3")
        XCTAssertEqual(content.type, "audio")
        XCTAssertEqual(content.data, "base64audio")
        XCTAssertEqual(content.format, "mp3")
        XCTAssertNil(content.url)
    }

    func test_initWithURLAndFormat_setsFormat() {
        let content = AudioInputContent(url: "https://example.com/audio.wav", format: "wav")
        XCTAssertEqual(content.format, "wav")
    }

    // MARK: - Protocol conformance

    func test_conformsToInputContent() {
        let content: any InputContent = AudioInputContent(url: "https://example.com/audio.mp3")
        XCTAssertEqual(content.type, "audio")
    }

    // MARK: - DTO decoding

    func test_dtoDecodeWithURL_succeeds() throws {
        let json = Data("""
        {"type":"audio","url":"https://example.com/clip.mp3","format":"mp3"}
        """.utf8)
        let dto = try AudioInputContentDTO.decode(from: json)
        let content = dto.toDomain()
        XCTAssertEqual(content.url, "https://example.com/clip.mp3")
        XCTAssertEqual(content.format, "mp3")
    }

    func test_dtoDecodeWithData_succeeds() throws {
        let json = Data("""
        {"type":"audio","data":"base64audiodata"}
        """.utf8)
        let dto = try AudioInputContentDTO.decode(from: json)
        let content = dto.toDomain()
        XCTAssertEqual(content.data, "base64audiodata")
    }

    func test_dtoDecodeWithNoSource_throws() {
        let json = Data("""
        {"type":"audio","format":"wav"}
        """.utf8)
        XCTAssertThrowsError(try AudioInputContentDTO.decode(from: json))
    }

    func test_dtoDecodeWithWrongType_throws() {
        let json = Data("""
        {"type":"image","url":"https://example.com/img.png"}
        """.utf8)
        XCTAssertThrowsError(try AudioInputContentDTO.decode(from: json))
    }

    // MARK: - Integration: decode via UserMessage

    func test_userMessage_withAudioContent_decodesFromJSON() throws {
        let json = """
        {
          "id": "msg-2",
          "role": "user",
          "content": [
            {"type": "audio", "url": "https://example.com/voice.mp3", "format": "mp3"}
          ]
        }
        """
        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))
        guard let userMsg = message as? UserMessage,
              let parts = userMsg.contentParts else {
            return XCTFail("Expected multimodal UserMessage")
        }
        XCTAssertEqual(parts.count, 1)
        guard let audioPart = parts[0] as? AudioInputContent else {
            return XCTFail("Expected AudioInputContent, got \(type(of: parts[0]))")
        }
        XCTAssertEqual(audioPart.url, "https://example.com/voice.mp3")
        XCTAssertEqual(audioPart.format, "mp3")
    }

    func test_userMessage_withAudioContent_encodesCorrectly() throws {
        let audio = AudioInputContent(url: "https://example.com/clip.wav", format: "wav")
        let userMsg = UserMessage.multimodal(id: "msg-2", parts: [audio])

        let encoder = MessageEncoder()
        let data = try encoder.encode(userMsg)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let contentArray = json?["content"] as? [[String: Any]]

        XCTAssertEqual(contentArray?[0]["type"] as? String, "audio")
        XCTAssertEqual(contentArray?[0]["url"] as? String, "https://example.com/clip.wav")
        XCTAssertEqual(contentArray?[0]["format"] as? String, "wav")
    }

    // MARK: - Equatable / Hashable / Sendable

    func test_equalContentAreEqual() {
        let c1 = AudioInputContent(url: "https://example.com/a.mp3", format: "mp3")
        let c2 = AudioInputContent(url: "https://example.com/a.mp3", format: "mp3")
        XCTAssertEqual(c1, c2)
    }

    func test_differentURLNotEqual() {
        XCTAssertNotEqual(
            AudioInputContent(url: "https://example.com/a.mp3"),
            AudioInputContent(url: "https://example.com/b.mp3")
        )
    }

    func test_hashable() {
        let set: Set<AudioInputContent> = [
            AudioInputContent(url: "https://example.com/a.mp3"),
            AudioInputContent(url: "https://example.com/b.mp3")
        ]
        XCTAssertEqual(set.count, 2)
    }

    func test_sendable() {
        let content = AudioInputContent(url: "https://example.com/clip.mp3")
        Task { XCTAssertEqual(content.type, "audio") }
    }

    // MARK: - mimeType

    func test_mimeType_isNilByDefault_url() {
        XCTAssertNil(AudioInputContent(url: "https://example.com/clip.mp3").mimeType)
    }

    func test_mimeType_isNilByDefault_data() {
        XCTAssertNil(AudioInputContent(data: "base64audio").mimeType)
    }

    func test_mimeType_roundTripsViaURLInit() {
        let content = AudioInputContent(url: "https://example.com/clip.mp3", mimeType: "audio/mpeg")
        XCTAssertEqual(content.mimeType, "audio/mpeg")
    }

    func test_mimeType_roundTripsViaDataInit() {
        let content = AudioInputContent(data: "base64audio", mimeType: "audio/wav")
        XCTAssertEqual(content.mimeType, "audio/wav")
    }

    func test_mimeType_decodesFromJSON() throws {
        let json = Data("""
        {"type":"audio","url":"https://example.com/clip.mp3","mimeType":"audio/mpeg"}
        """.utf8)
        let dto = try AudioInputContentDTO.decode(from: json)
        let content = dto.toDomain()
        XCTAssertEqual(content.mimeType, "audio/mpeg")
    }

    func test_mimeType_isNilWhenAbsentInJSON() throws {
        let json = Data("""
        {"type":"audio","url":"https://example.com/clip.mp3"}
        """.utf8)
        let dto = try AudioInputContentDTO.decode(from: json)
        let content = dto.toDomain()
        XCTAssertNil(content.mimeType)
    }

    func test_encodeUserMessage_withAudioMimeType_includesMimeTypeInJSON() throws {
        let audio = AudioInputContent(url: "https://example.com/clip.mp3", mimeType: "audio/mpeg")
        let userMsg = UserMessage.multimodal(id: "msg-1", parts: [audio])
        let encoder = MessageEncoder()
        let data = try encoder.encode(userMsg)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let contentArray = json?["content"] as? [[String: Any]]
        XCTAssertEqual(contentArray?[0]["mimeType"] as? String, "audio/mpeg")
    }
}
