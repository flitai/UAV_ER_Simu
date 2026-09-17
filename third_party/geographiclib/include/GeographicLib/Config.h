/* Config.h -- 本项目手写，不是上游原件。
 *
 * 上游的 Config.h 由它自己的 CMake 从 include/GeographicLib/Config.h.in 生成；
 * 本项目只抽取 Geocentric / LocalCartesian 两个类（见同目录 README.md），
 * 不引上游的 CMake 工程，因此这一份按抽取需要手写，取值与理由逐条记在下面。
 *
 * 本文件是 third_party/geographiclib/ 下唯一不是上游逐字节原件的文件。
 * 其余七个文件保留上游原始文件头与内容，一个字节未改（CLAUDE.md 铁律 13）。
 */

#define GEOGRAPHICLIB_VERSION_STRING "2.5.2"
#define GEOGRAPHICLIB_VERSION_MAJOR 2
#define GEOGRAPHICLIB_VERSION_MINOR 5
#define GEOGRAPHICLIB_VERSION_PATCH 2

/* 大地水准面、磁场、重力那三类模型的数据目录。本项目不抽取它们，故为空串。
 * 将来若为垂直基准启用 Geoid，数据文件按离线资产另行登记（铁律 6）。 */
#define GEOGRAPHICLIB_DATA ""

/* 0 = 强制不使用 long double。
 *
 * PRECISION 取 2 时 Math::real 就是 double，Math::extended 在本抽取范围内不参与任何计算，
 * 所以这一项本来是惰性的。仍然设成 0，是为了从源头堵掉一个跨平台隐患：
 * long double 在 MSVC 上是 64 位、在 clang / gcc 的 x86 上是 80 位，
 * 一旦将来有代码路径走到它，同一份输入在两个目标平台上就会给出不同的位。
 * 交付平台是 Windows 与 Linux 双平台（铁律 16），这个口子不留。 */
#define GEOGRAPHICLIB_HAVE_LONG_DOUBLE 0

/* 两个目标平台都是小端（x64）。 */
#define GEOGRAPHICLIB_WORDS_BIGENDIAN 0

/* 2 = double。本项目内部一律 double（铁律 5 的 SI 与双精度约定），
 * 不取 1（float）、3（long double）或 4 以上（需要 boost 或 mpfr 这类外部依赖）。 */
#define GEOGRAPHICLIB_PRECISION 2

/* 0 = 静态库。抽取的三个源文件直接编进 cuav_geo 这个静态库，不做动态库。 */
#if !defined(GEOGRAPHICLIB_SHARED_LIB)
#define GEOGRAPHICLIB_SHARED_LIB 0
#endif
