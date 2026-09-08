#include "cuav/sha256.h"

#include <cstdio>
#include <cstring>
#include <vector>

namespace cuav {
namespace {

const std::uint32_t K[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u,
    0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u,
    0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
    0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
    0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au,
    0x5b9cca4fu, 0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};

inline std::uint32_t rotr(std::uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

}  // namespace

Sha256::Sha256() : buf_len_(0), total_bits_(0), done_(false) {
    h_[0] = 0x6a09e667u; h_[1] = 0xbb67ae85u; h_[2] = 0x3c6ef372u; h_[3] = 0xa54ff53au;
    h_[4] = 0x510e527fu; h_[5] = 0x9b05688cu; h_[6] = 0x1f83d9abu; h_[7] = 0x5be0cd19u;
    std::memset(buf_, 0, sizeof(buf_));
}

void Sha256::compress(const std::uint8_t block[64]) {
    std::uint32_t w[64];
    for (int i = 0; i < 16; ++i) {
        w[i] = (static_cast<std::uint32_t>(block[i * 4]) << 24) |
               (static_cast<std::uint32_t>(block[i * 4 + 1]) << 16) |
               (static_cast<std::uint32_t>(block[i * 4 + 2]) << 8) |
               static_cast<std::uint32_t>(block[i * 4 + 3]);
    }
    for (int i = 16; i < 64; ++i) {
        const std::uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
        const std::uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    std::uint32_t a = h_[0], b = h_[1], c = h_[2], d = h_[3];
    std::uint32_t e = h_[4], f = h_[5], g = h_[6], hh = h_[7];
    for (int i = 0; i < 64; ++i) {
        const std::uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const std::uint32_t ch = (e & f) ^ ((~e) & g);
        const std::uint32_t t1 = hh + S1 + ch + K[i] + w[i];
        const std::uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const std::uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        const std::uint32_t t2 = S0 + maj;
        hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h_[0] += a; h_[1] += b; h_[2] += c; h_[3] += d;
    h_[4] += e; h_[5] += f; h_[6] += g; h_[7] += hh;
}

void Sha256::update(const void* data, std::size_t len) {
    if (done_) return;
    const std::uint8_t* p = static_cast<const std::uint8_t*>(data);
    total_bits_ += static_cast<std::uint64_t>(len) * 8u;
    while (len > 0) {
        const std::size_t take = (64 - buf_len_ < len) ? (64 - buf_len_) : len;
        std::memcpy(buf_ + buf_len_, p, take);
        buf_len_ += take;
        p += take;
        len -= take;
        if (buf_len_ == 64) {
            compress(buf_);
            buf_len_ = 0;
        }
    }
}

std::string Sha256::hex() {
    if (done_) return hex_;
    const std::uint64_t bits = total_bits_;
    std::uint8_t pad = 0x80;
    update(&pad, 1);
    total_bits_ = bits;   // padding 不计入长度
    pad = 0x00;
    while (buf_len_ != 56) {
        update(&pad, 1);
        total_bits_ = bits;
    }
    std::uint8_t len_be[8];
    for (int i = 0; i < 8; ++i) len_be[i] = static_cast<std::uint8_t>((bits >> (56 - 8 * i)) & 0xffu);
    update(len_be, 8);
    total_bits_ = bits;

    char out[65];
    for (int i = 0; i < 8; ++i) {
        std::snprintf(out + i * 8, 9, "%08x", h_[i]);
    }
    hex_.assign(out, 64);
    done_ = true;
    return hex_;
}

std::string sha256_hex(const std::string& bytes) {
    Sha256 s;
    s.update(bytes.data(), bytes.size());
    return s.hex();
}

bool sha256_file(const std::string& path, std::string& hex, std::string& err) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (f == 0) {
        err = "打不开文件：" + path;
        return false;
    }
    Sha256 s;
    std::vector<char> buf(1 << 16);
    for (;;) {
        const std::size_t n = std::fread(&buf[0], 1, buf.size(), f);
        if (n > 0) s.update(&buf[0], n);
        if (n < buf.size()) break;
    }
    const bool bad = (std::ferror(f) != 0);
    std::fclose(f);
    if (bad) {
        err = "读文件出错：" + path;
        return false;
    }
    hex = s.hex();
    return true;
}

}  // namespace cuav
