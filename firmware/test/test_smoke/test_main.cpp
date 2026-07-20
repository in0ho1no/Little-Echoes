// native環境（ホスト側Unity）が機能することを確認するスモークテスト。
// タスク1以降、パケットパーサ等の実テストに置き換わっていく。
#include <unity.h>

#include <cstdint>

void setUp() {}
void tearDown() {}

// C++17がnative環境で有効なこと
static void test_cpp17_toolchain_works() {
    if constexpr (sizeof(std::uint32_t) == 4) {
        TEST_ASSERT_TRUE(true);
    } else {
        TEST_FAIL_MESSAGE("uint32_t is not 4 bytes");
    }
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_cpp17_toolchain_works);
    return UNITY_END();
}
