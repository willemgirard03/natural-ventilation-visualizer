"""Compare two EnergyPlus .eso files, matching outputs by (key, variable name)."""
import sys, collections, math


def read_eso(path):
    ids, data = {}, collections.defaultdict(list)
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("End of Data Dictionary"):
                break
            p = line.strip().split(",")
            if len(p) >= 4 and p[0].isdigit() and int(p[0]) > 6:
                ids[p[0]] = (p[2].strip().upper(), p[3].split("!")[0].strip())
        for line in f:
            p = line.split(",", 2)
            if p[0] in ids and len(p) >= 2:
                try:
                    data[ids[p[0]]].append(float(p[1]))
                except ValueError:
                    pass
    return data


def main(a_path, b_path):
    A, B = read_eso(a_path), read_eso(b_path)
    common = sorted(set(A) & set(B))
    print("outputs: A %d, B %d, common %d" % (len(A), len(B), len(common)))
    if set(A) - set(B):
        print("only in A:", sorted(set(A) - set(B))[:5])
    by_var = collections.defaultdict(list)
    for k in common:
        a, b = A[k], B[k]
        n = min(len(a), len(b))
        if n == 0:
            continue
        diffs = [abs(x - y) for x, y in zip(a[:n], b[:n])]
        sa, sb = sum(a[:n]), sum(b[:n])
        by_var[k[1]].append((k[0], n, len(a), len(b), max(diffs), sum(diffs) / n, sa, sb))
    for var, rows in sorted(by_var.items()):
        mx = max(r[4] for r in rows)
        mean = sum(r[5] for r in rows) / len(rows)
        tot_a = sum(r[6] for r in rows)
        tot_b = sum(r[7] for r in rows)
        rel = abs(tot_a - tot_b) / abs(tot_a) * 100 if tot_a else 0.0
        nvals = {(r[2], r[3]) for r in rows}
        print("%-62s zones %2d  max|d| %-10.4g mean|d| %-10.4g sum diff %.4f%%  n=%s"
              % (var[:62], len(rows), mx, mean, rel, sorted(nvals)[:2]))
    return A, B


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
