// 冒烟测试：只验证构建、链接与运行三步是否打通，不验证任何业务逻辑。
//
// 正式测试框架尚未落位。emcore 使用随代码提供的 doctest，移植时一并带入。
// 黄金基准对拍的相对误差上限是 1e-9（铁律 10）。
#include "cuav_geo_version.h"

#include <cstdio>

int main() {
  if (cuav::cuav_geo_version() != 0) {
    std::printf("冒烟测试失败：版本号不是 0\n");
    return 1;
  }
  std::printf("冒烟测试通过：cuav_geo\n");
  return 0;
}
