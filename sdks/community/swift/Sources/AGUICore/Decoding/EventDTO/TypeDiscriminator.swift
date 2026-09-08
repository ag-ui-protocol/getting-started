// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Internal structure for reading the "type" field during polymorphic decoding.

struct TypeDiscriminator: Decodable {
    let typeRaw: String

    enum CodingKeys: String, CodingKey { case type }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.typeRaw = try container.decode(String.self, forKey: .type)
    }
}
