import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { analyzeProduct, researchProduct, type ResearchBundle } from "../lib/api";

type AnalysisResult = {
  decision?: {
    target?: string;
    problem?: string;
    valueProposition?: string;
    channel?: string;
    testPlan?: string;
  };
};

export default function HomeScreen() {
  const [url, setUrl] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [research, setResearch] = useState<ResearchBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    if (!url.trim()) return;
    setLoading(true); setError(""); setAnalysis(null); setResearch(null);
    try {
      const [a, r] = await Promise.all([analyzeProduct(url.trim()), researchProduct(url.trim())]);
      setAnalysis(a); setResearch(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "分析に失敗しました。");
    } finally { setLoading(false); }
  }

  const pains = research?.research?.analysis?.pain_points ?? [];
  const angles = research?.research?.analysis?.ad_copy_candidates ?? [];
  const products = research?.products ?? [];
  const opportunity = research?.opportunity;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <View><Text style={styles.brand}>AI Acquisition Search</Text><Text style={styles.subbrand}>AI集客検索エンジン</Text></View>
          <Text style={styles.status}>AI OPERATOR</Text>
        </View>

        <View style={styles.hero}>
          <Text style={styles.eyebrow}>AI CUSTOMER ACQUISITION</Text>
          <Text style={styles.title}>市場の声から、{"\n"}次の商品と広告を決める。</Text>
          <Text style={styles.lead}>商品URLから市場・レビュー・顧客の痛点を調査。頻出する不満から商品候補と広告訴求を作ります。</Text>
          <TextInput
            value={url} onChangeText={setUrl} placeholder="https://example.com/product"
            placeholderTextColor="#68686f" autoCapitalize="none" autoCorrect={false} keyboardType="url"
            returnKeyType="go" onSubmitEditing={run} style={styles.input}
          />
          <Pressable onPress={run} disabled={loading || !url.trim()} style={({pressed}) => [styles.button, (!url.trim() || loading) && styles.buttonDisabled, pressed && styles.buttonPressed]}>
            {loading ? <ActivityIndicator color="#080809" /> : <Text style={styles.buttonText}>集客分析を開始</Text>}
          </Pressable>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>

        {loading ? <View style={styles.loadingCard}><ActivityIndicator size="small" color="#fff" /><Text style={styles.loadingText}>市場 → 痛点 → 商品 → 広告を分析中…</Text></View> : null}

        {research?.connected && research.research?.analysis ? <>
          <Section eyebrow="01 PAIN POINTS" title="頻出する顧客の痛み">
            {pains.slice(0,5).map(p => <View style={styles.row} key={p.pain}><View style={styles.rowMain}><Text style={styles.rowTitle}>{p.pain}</Text><Text style={styles.meta}>{p.count}件 · {p.share_percent}%</Text></View><Text style={styles.example} numberOfLines={2}>{p.examples?.[0] || "レビュー例なし"}</Text></View>)}
          </Section>

          <Section eyebrow="02 AD ANGLES" title="広告で検証する訴求">
            <Text style={styles.highlight}>{research.research.analysis.recommended_angle || "頻出痛点を訴求軸として検証"}</Text>
            {angles.slice(0,4).map((a,i) => <Text style={styles.bullet} key={i}>• {a}</Text>)}
          </Section>

          <Section eyebrow="03 PRODUCT CANDIDATES" title="痛点から探した商品候補">
            {products.slice(0,6).map((p,i) => <View style={styles.candidate} key={p.url || String(i)}><Text style={styles.rowTitle} numberOfLines={2}>{p.title || "商品候補"}</Text><Text style={styles.meta}>{p.marketplace || "market"} · {p.price ?? "-"} {p.currency || ""}</Text></View>)}
            {!products.length ? <Text style={styles.muted}>商品候補を取得できませんでした。</Text> : null}
          </Section>

          {opportunity ? <Section eyebrow="04 OPPORTUNITY ENGINE" title="痛点 → 商品設計 → 広告テスト">
            {opportunity.top_pain ? <View style={styles.topPain}><Text style={styles.meta}>最重要痛点</Text><Text style={styles.highlight}>{opportunity.top_pain.pain}</Text><Text style={styles.meta}>{opportunity.top_pain.count}件 / {opportunity.top_pain.share_percent}%</Text></View> : null}
            {(opportunity.ad_test_angles || []).slice(0,3).map((a,i) => <View style={styles.angle} key={i}><Text style={styles.rowTitle}>{a.hook}</Text><Text style={styles.meta}>{a.proof}</Text></View>)}
          </Section> : null}

          <Section eyebrow="05 NEXT TEST" title="次の広告テスト">
            <Text style={styles.highlight}>「{research.research.analysis.recommended_angle || "最頻出の顧客痛点"}」を主訴求にして検証</Text>
            <Text style={styles.body}>短尺動画・静止画の2パターンを作り、クリック率と購入率で比較します。</Text>
          </Section>
        </> : null}

        {analysis ? <Section eyebrow="DECISION ENGINE" title="次に何をすべきか">
          <Decision label="狙う顧客" value={analysis.decision?.target} />
          <Decision label="顧客の問題" value={analysis.decision?.problem} />
          <Decision label="訴求" value={analysis.decision?.valueProposition} />
          <Decision label="媒体" value={analysis.decision?.channel} />
          <Decision label="検証方法" value={analysis.decision?.testPlan} />
        </Section> : null}

        <View style={styles.loop}><Text style={styles.eyebrow}>RESEARCH LOOP</Text><Text style={styles.loopText}>RESEARCH → PAIN POINT → PRODUCT → AD TEST → LEARN</Text></View>
        <Text style={styles.footer}>Android / iOS共通アプリ。Webと同じ分析基盤を利用します。</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({eyebrow,title,children}:{eyebrow:string;title:string;children:ReactNode}) {
  return <View style={styles.section}><Text style={styles.eyebrow}>{eyebrow}</Text><Text style={styles.sectionTitle}>{title}</Text><View style={styles.sectionBody}>{children}</View></View>;
}
function Decision({label,value}:{label:string;value?:string}) {
  return value ? <View style={styles.decision}><Text style={styles.meta}>{label}</Text><Text style={styles.body}>{value}</Text></View> : null;
}

const styles=StyleSheet.create({
  safe:{flex:1,backgroundColor:"#080809"}, container:{padding:20,paddingBottom:48,maxWidth:760,width:"100%",alignSelf:"center"},
  header:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",marginBottom:28}, brand:{color:"#fff",fontSize:18,fontWeight:"800"}, subbrand:{color:"#77777e",fontSize:11,marginTop:3}, status:{color:"#8f8f96",fontSize:9,letterSpacing:1.2},
  hero:{paddingVertical:10,marginBottom:18}, eyebrow:{color:"#85858d",fontSize:10,fontWeight:"700",letterSpacing:1.8,marginBottom:9}, title:{color:"#fff",fontSize:34,lineHeight:42,fontWeight:"800",letterSpacing:-1.2},
  lead:{color:"#a7a7ae",fontSize:14,lineHeight:22,marginTop:14,marginBottom:18}, input:{backgroundColor:"#151518",borderColor:"#29292e",borderWidth:1,borderRadius:12,color:"#fff",paddingHorizontal:15,paddingVertical:14,fontSize:14},
  button:{marginTop:10,backgroundColor:"#fff",borderRadius:12,minHeight:50,alignItems:"center",justifyContent:"center"}, buttonDisabled:{opacity:.45}, buttonPressed:{opacity:.75}, buttonText:{color:"#080809",fontWeight:"800",fontSize:14}, error:{color:"#ff8f8f",marginTop:12,lineHeight:20},
  loadingCard:{flexDirection:"row",gap:10,alignItems:"center",backgroundColor:"#111114",borderRadius:14,padding:16,marginBottom:14}, loadingText:{color:"#b8b8be",fontSize:13},
  section:{backgroundColor:"#101012",borderColor:"#242428",borderWidth:1,borderRadius:18,padding:17,marginBottom:14}, sectionTitle:{color:"#fff",fontSize:20,fontWeight:"800",marginBottom:15}, sectionBody:{gap:12},
  row:{paddingVertical:10,borderBottomColor:"#242428",borderBottomWidth:1}, rowMain:{flexDirection:"row",justifyContent:"space-between",gap:12}, rowTitle:{color:"#fff",fontSize:14,fontWeight:"700",flex:1}, meta:{color:"#77777e",fontSize:11,lineHeight:17}, example:{color:"#9a9aa1",fontSize:12,lineHeight:18,marginTop:5},
  highlight:{color:"#fff",fontSize:16,lineHeight:24,fontWeight:"700"}, bullet:{color:"#b1b1b8",fontSize:13,lineHeight:20}, candidate:{paddingVertical:10,borderBottomColor:"#242428",borderBottomWidth:1}, muted:{color:"#6f6f76",fontSize:13},
  topPain:{backgroundColor:"#17171b",borderRadius:12,padding:13,gap:4}, angle:{backgroundColor:"#17171b",borderRadius:12,padding:12,gap:4}, body:{color:"#b0b0b7",fontSize:13,lineHeight:21},
  decision:{borderTopColor:"#242428",borderTopWidth:1,paddingTop:10}, loop:{borderRadius:18,borderWidth:1,borderColor:"#29292e",padding:18,marginTop:4}, loopText:{color:"#fff",fontSize:12,lineHeight:20,fontWeight:"700",letterSpacing:.6},
  footer:{color:"#5f5f66",textAlign:"center",fontSize:11,lineHeight:18,marginTop:24}
});
